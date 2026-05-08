// Export every notebook (with pages, strokes, and worksheet blobs) into a
// single JSON file the user can save to the iPad's Files app — and import
// it back later. This is the safety net against IndexedDB eviction or a
// damaged install. Homework is non-negotiable.

import { getDB } from '../db.js';

const FORMAT = { app: 'MathApp', version: 1 };

export async function exportNotebooksToJSON() {
  const db = await getDB();
  const notebooks = await db.getAll('notebooks');
  const allPages = await db.getAll('pages');
  const allStrokes = await db.getAll('strokes');
  const allBlobs = await db.getAll('blobs');

  const result = {
    ...FORMAT,
    exportedAt: new Date().toISOString(),
    notebooks: [],
    blobs: {}
  };

  const pagesByNotebook = new Map();
  for (const p of allPages) {
    if (!pagesByNotebook.has(p.notebookId)) pagesByNotebook.set(p.notebookId, []);
    pagesByNotebook.get(p.notebookId).push(p);
  }
  const strokesByPage = new Map();
  for (const s of allStrokes) {
    if (!strokesByPage.has(s.pageId)) strokesByPage.set(s.pageId, []);
    strokesByPage.get(s.pageId).push(s);
  }

  const referencedBlobIds = new Set();
  for (const nb of notebooks) {
    const pages = (pagesByNotebook.get(nb.id) || []).sort((a, b) => a.index - b.index);
    const richPages = pages.map((p) => ({
      ...p,
      strokes: (strokesByPage.get(p.id) || []).sort((a, b) => a.createdAt - b.createdAt)
    }));
    for (const p of richPages) {
      for (const block of p.blocks || []) {
        if (block.type === 'worksheet' && block.blobId) referencedBlobIds.add(block.blobId);
      }
    }
    result.notebooks.push({
      id: nb.id,
      name: nb.name,
      createdAt: nb.createdAt,
      updatedAt: nb.updatedAt,
      pages: richPages
    });
  }

  for (const blob of allBlobs) {
    if (!referencedBlobIds.has(blob.id)) continue;
    result.blobs[blob.id] = {
      type: blob.blob.type || 'image/png',
      data: await blobToDataURL(blob.blob)
    };
  }

  return result;
}

// Same shape as exportNotebooksToJSON, but for a single notebook. The
// resulting JSON imports back through importNotebooksFromJSON unchanged
// (the importer iterates over `notebooks` regardless of count).
export async function exportSingleNotebookToJSON(notebookId) {
  const db = await getDB();
  const nb = await db.get('notebooks', notebookId);
  if (!nb) throw new Error('Notebook not found: ' + notebookId);
  const allPages = await db.getAllFromIndex('pages', 'byNotebook', notebookId);
  const pages = allPages.sort((a, b) => a.index - b.index);

  const referencedBlobIds = new Set();
  const richPages = [];
  for (const p of pages) {
    const strokes = (await db.getAllFromIndex('strokes', 'byPage', p.id)).sort(
      (a, b) => a.createdAt - b.createdAt
    );
    richPages.push({ ...p, strokes });
    for (const block of p.blocks || []) {
      if (block.type === 'worksheet' && block.blobId) referencedBlobIds.add(block.blobId);
    }
  }

  const blobs = {};
  for (const blobId of referencedBlobIds) {
    const record = await db.get('blobs', blobId);
    if (!record) continue;
    blobs[blobId] = {
      type: record.blob.type || 'image/png',
      data: await blobToDataURL(record.blob)
    };
  }

  return {
    ...FORMAT,
    exportedAt: new Date().toISOString(),
    notebooks: [
      {
        id: nb.id,
        name: nb.name,
        createdAt: nb.createdAt,
        updatedAt: nb.updatedAt,
        pages: richPages
      }
    ],
    blobs
  };
}

export async function downloadJSON(data, filename = 'mathapp-backup.json') {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 200);
}

// Open the native iPadOS share sheet so the user can save the backup to
// Files (iCloud Drive), the Google Drive app, Email, AirDrop, etc.
// Falls back to plain download on browsers without Web Share API support.
export async function shareJSON(data, filename = 'mathapp-backup.json') {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'גיבוי MathApp',
        text: 'גיבוי המחברות'
      });
      return 'shared';
    } catch (err) {
      // User cancelled, or share failed — fall back to download.
      if (err && err.name === 'AbortError') return 'cancelled';
      console.warn('Share failed, falling back to download:', err);
    }
  }
  triggerDownload(blob, filename);
  return 'downloaded';
}

export async function importNotebooksFromJSON(json) {
  if (!json || json.app !== FORMAT.app || !Array.isArray(json.notebooks)) {
    throw new Error('פורמט קובץ לא תקין');
  }
  const db = await getDB();
  let importedCount = 0;
  for (const nb of json.notebooks) {
    const newNbId = uid('nb');
    await db.put('notebooks', {
      id: newNbId,
      name: nb.name + ' (משוחזר)',
      createdAt: nb.createdAt || Date.now(),
      updatedAt: Date.now()
    });

    const blobIdMap = new Map(); // old blobId -> new blobId

    for (const page of nb.pages || []) {
      const newPageId = uid('pg');
      const newBlocks = [];
      // Old block id -> new block id, so stroke.blockId references can be
      // rewritten below. Without this, restored strokes would be orphans
      // (their anchor block has a fresh id) and be skipped on render.
      const blockIdMap = new Map();
      for (const block of page.blocks || []) {
        const newBlockId = uid('b');
        blockIdMap.set(block.id, newBlockId);
        if (block.type === 'worksheet' && block.blobId) {
          let newBlobId = blobIdMap.get(block.blobId);
          if (!newBlobId) {
            const blobInfo = (json.blobs || {})[block.blobId];
            if (blobInfo && blobInfo.data) {
              newBlobId = uid('blob');
              const blob = await dataURLToBlob(blobInfo.data);
              await db.put('blobs', { id: newBlobId, blob });
              blobIdMap.set(block.blobId, newBlobId);
            }
          }
          newBlocks.push({ ...block, id: newBlockId, blobId: newBlobId });
        } else {
          newBlocks.push({ ...block, id: newBlockId });
        }
      }
      await db.put('pages', {
        id: newPageId,
        notebookId: newNbId,
        index: page.index ?? 0,
        blocks: newBlocks,
        updatedAt: Date.now()
      });
      for (const stroke of page.strokes || []) {
        const remappedBlockId = stroke.blockId
          ? blockIdMap.get(stroke.blockId) || null
          : null;
        await db.put('strokes', {
          ...stroke,
          id: uid('stroke'),
          pageId: newPageId,
          blockId: remappedBlockId
        });
      }
    }
    importedCount += 1;
  }
  return importedCount;
}

// Helpers

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const resp = await fetch(dataUrl);
  return resp.blob();
}

// File picker for JSON imports.
export function pickJSONFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    let resolved = false;
    const finish = (file) => {
      if (resolved) return;
      resolved = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () =>
      finish(input.files && input.files[0] ? input.files[0] : null)
    );
    input.addEventListener('cancel', () => finish(null));
    const onFocus = () => {
      setTimeout(() => {
        if (!resolved) finish(null);
        window.removeEventListener('focus', onFocus);
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        resolve(JSON.parse(fr.result));
      } catch (err) {
        reject(err);
      }
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}
