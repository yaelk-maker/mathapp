import { openDB, runInTransaction, requestToPromise } from '../vendor/idb.js';

const DB_NAME = 'mathapp';
const DB_VERSION = 1;

let _db;

export async function getDB() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains('notebooks')) {
      db.createObjectStore('notebooks', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('pages')) {
      const s = db.createObjectStore('pages', { keyPath: 'id' });
      s.createIndex('byNotebook', 'notebookId', { unique: false });
    }
    if (!db.objectStoreNames.contains('blobs')) {
      db.createObjectStore('blobs', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('strokes')) {
      const s = db.createObjectStore('strokes', { keyPath: 'id' });
      s.createIndex('byPage', 'pageId', { unique: false });
    }
  });
  return _db;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function listNotebooks() {
  const db = await getDB();
  const all = await db.getAll('notebooks');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getNotebook(id) {
  const db = await getDB();
  return db.get('notebooks', id);
}

export async function createNotebook(name) {
  const db = await getDB();
  const now = Date.now();
  const notebook = {
    id: uid('nb'),
    name,
    createdAt: now,
    updatedAt: now
  };
  const firstPage = {
    id: uid('pg'),
    notebookId: notebook.id,
    index: 0,
    blocks: [],
    updatedAt: now
  };
  await runInTransaction(db, ['notebooks', 'pages'], 'readwrite', (tx) => {
    tx.objectStore('notebooks').put(notebook);
    tx.objectStore('pages').put(firstPage);
  });
  return notebook;
}

export async function renameNotebook(id, name) {
  const db = await getDB();
  const nb = await db.get('notebooks', id);
  if (!nb) return null;
  nb.name = name;
  nb.updatedAt = Date.now();
  await db.put('notebooks', nb);
  return nb;
}

export async function deleteNotebook(id) {
  const db = await getDB();
  await runInTransaction(
    db,
    ['notebooks', 'pages', 'blobs', 'strokes'],
    'readwrite',
    async (tx) => {
      const pages = await requestToPromise(
        tx.objectStore('pages').index('byNotebook').getAll(id)
      );
      for (const page of pages) {
        // Strokes by page
        const strokes = await requestToPromise(
          tx.objectStore('strokes').index('byPage').getAll(page.id)
        );
        for (const stroke of strokes) tx.objectStore('strokes').delete(stroke.id);
        // Worksheet blob references in page blocks
        for (const block of page.blocks || []) {
          if (block.type === 'worksheet' && block.blobId) {
            tx.objectStore('blobs').delete(block.blobId);
          }
        }
        tx.objectStore('pages').delete(page.id);
      }
      tx.objectStore('notebooks').delete(id);
    }
  );
}

export async function listPages(notebookId) {
  const db = await getDB();
  const pages = await db.getAllFromIndex('pages', 'byNotebook', notebookId);
  return pages.sort((a, b) => a.index - b.index);
}

export async function getPage(id) {
  const db = await getDB();
  return db.get('pages', id);
}

export async function savePage(page) {
  const db = await getDB();
  page.updatedAt = Date.now();
  await runInTransaction(db, ['pages', 'notebooks'], 'readwrite', async (tx) => {
    tx.objectStore('pages').put(page);
    const nb = await requestToPromise(tx.objectStore('notebooks').get(page.notebookId));
    if (nb) {
      nb.updatedAt = page.updatedAt;
      tx.objectStore('notebooks').put(nb);
    }
  });
  return page;
}

export async function putBlob(id, blob) {
  const db = await getDB();
  await db.put('blobs', { id, blob });
  return id;
}

export async function getBlob(id) {
  const db = await getDB();
  const record = await db.get('blobs', id);
  return record ? record.blob : null;
}

export async function deleteBlob(id) {
  const db = await getDB();
  await db.delete('blobs', id);
}

export async function listStrokesByPage(pageId) {
  const db = await getDB();
  const strokes = await db.getAllFromIndex('strokes', 'byPage', pageId);
  return strokes.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addStroke(stroke) {
  const db = await getDB();
  await db.put('strokes', stroke);
  return stroke;
}

export async function deleteStrokeById(id) {
  const db = await getDB();
  await db.delete('strokes', id);
}

export async function clearStrokesForPage(pageId) {
  const db = await getDB();
  const strokes = await db.getAllFromIndex('strokes', 'byPage', pageId);
  await runInTransaction(db, ['strokes'], 'readwrite', (tx) => {
    for (const s of strokes) tx.objectStore('strokes').delete(s.id);
  });
}

export async function requestPersistentStorage() {
  if (!('storage' in navigator) || !navigator.storage.persist) return false;
  try {
    const already = await navigator.storage.persisted();
    if (already) return true;
    return await navigator.storage.persist();
  } catch (_) {
    return false;
  }
}
