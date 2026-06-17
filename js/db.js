import { openDB, runInTransaction, requestToPromise } from '../vendor/idb.js';

const DB_NAME = 'mathapp';
const DB_VERSION = 3;

// Recently-deleted notebooks live in the `trash` store for this long before
// being permanently dropped on the next app start. 30 days mirrors iOS Photos
// "Recently Deleted" so it matches the kid's mental model.
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    // Trash records are self-contained snapshots — the whole notebook plus
    // its pages, strokes, and worksheet blob bytes — so restoring is a pure
    // re-insert and purging is a single delete.
    if (!db.objectStoreNames.contains('trash')) {
      db.createObjectStore('trash', { keyPath: 'id' });
    }
    // v3: folders to group notebooks on the home screen. Notebooks gain a
    // nullable `folderId` (null = top level). No data migration is needed —
    // existing notebooks keep folderId === undefined which the home screen
    // treats the same as null.
    if (!db.objectStoreNames.contains('folders')) {
      db.createObjectStore('folders', { keyPath: 'id' });
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

export async function createNotebook(name, folderId = null) {
  const db = await getDB();
  const now = Date.now();
  const notebook = {
    id: uid('nb'),
    name,
    folderId: folderId || null,
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

// Soft delete: move the notebook (with all of its pages, strokes, and
// worksheet blob bytes) into the `trash` store and remove the live records.
// The kid can restore it from the "נמחקו לאחרונה" screen for TRASH_TTL_MS,
// after which purgeExpiredTrash() drops it permanently on app start.
export async function deleteNotebook(id) {
  const db = await getDB();
  await runInTransaction(
    db,
    ['notebooks', 'pages', 'blobs', 'strokes', 'trash'],
    'readwrite',
    async (tx) => {
      const nb = await requestToPromise(tx.objectStore('notebooks').get(id));
      if (!nb) return;
      const pages = await requestToPromise(
        tx.objectStore('pages').index('byNotebook').getAll(id)
      );

      const trashedPages = [];
      const trashedStrokes = [];
      const trashedBlobs = [];
      const seenBlobIds = new Set();

      for (const page of pages) {
        const strokes = await requestToPromise(
          tx.objectStore('strokes').index('byPage').getAll(page.id)
        );
        for (const stroke of strokes) {
          trashedStrokes.push(stroke);
          tx.objectStore('strokes').delete(stroke.id);
        }
        for (const block of page.blocks || []) {
          if (block.type === 'worksheet' && block.blobId && !seenBlobIds.has(block.blobId)) {
            seenBlobIds.add(block.blobId);
            const record = await requestToPromise(tx.objectStore('blobs').get(block.blobId));
            if (record) trashedBlobs.push(record);
            tx.objectStore('blobs').delete(block.blobId);
          }
        }
        trashedPages.push(page);
        tx.objectStore('pages').delete(page.id);
      }

      tx.objectStore('trash').put({
        id: nb.id,
        deletedAt: Date.now(),
        notebook: nb,
        pages: trashedPages,
        strokes: trashedStrokes,
        blobs: trashedBlobs
      });
      tx.objectStore('notebooks').delete(id);
    }
  );
}

export async function listTrash() {
  const db = await getDB();
  const all = await db.getAll('trash');
  return all.sort((a, b) => b.deletedAt - a.deletedAt);
}

// Re-insert a trashed notebook with its original ids. If the same notebook id
// somehow already exists live (shouldn't happen — delete removed it — but
// guarding against a corrupted state), the existing record wins and the trash
// entry is removed so the kid isn't stuck with a ghost in the trash list.
export async function restoreNotebookFromTrash(id) {
  const db = await getDB();
  await runInTransaction(
    db,
    ['notebooks', 'pages', 'blobs', 'strokes', 'trash'],
    'readwrite',
    async (tx) => {
      const entry = await requestToPromise(tx.objectStore('trash').get(id));
      if (!entry) return;
      const existing = await requestToPromise(tx.objectStore('notebooks').get(id));
      if (!existing) {
        tx.objectStore('notebooks').put(entry.notebook);
        for (const page of entry.pages || []) tx.objectStore('pages').put(page);
        for (const stroke of entry.strokes || []) tx.objectStore('strokes').put(stroke);
        for (const blob of entry.blobs || []) tx.objectStore('blobs').put(blob);
      }
      tx.objectStore('trash').delete(id);
    }
  );
}

export async function purgeNotebookFromTrash(id) {
  const db = await getDB();
  await db.delete('trash', id);
}

// Purge every trashed notebook in one shot — backs the "empty trash" button.
// Deletes id-by-id (mirroring purgeExpiredTrash) so we don't depend on a
// store-clear helper. Returns the number purged.
export async function purgeAllTrash() {
  const db = await getDB();
  const all = await db.getAll('trash');
  for (const entry of all) {
    await db.delete('trash', entry.id);
  }
  return all.length;
}

// Drop trash entries older than TRASH_TTL_MS. Called once on app start so the
// kid doesn't have to think about cleanup. Returns the number purged.
export async function purgeExpiredTrash(now = Date.now()) {
  const db = await getDB();
  const all = await db.getAll('trash');
  let purged = 0;
  for (const entry of all) {
    if (now - entry.deletedAt >= TRASH_TTL_MS) {
      await db.delete('trash', entry.id);
      purged += 1;
    }
  }
  return purged;
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

// ---- Folders ----

// Folders are pure groupings on the home screen — the kid sees a folder card
// that, when tapped, opens a folder view listing the notebooks inside. A
// notebook's `folderId` field points at one folder or is null (top level).
export async function listFolders() {
  const db = await getDB();
  const all = await db.getAll('folders');
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getFolder(id) {
  const db = await getDB();
  return db.get('folders', id);
}

export async function createFolder(name) {
  const db = await getDB();
  const now = Date.now();
  const folder = {
    id: uid('fl'),
    name,
    createdAt: now,
    updatedAt: now
  };
  await db.put('folders', folder);
  return folder;
}

export async function renameFolder(id, name) {
  const db = await getDB();
  const folder = await db.get('folders', id);
  if (!folder) return null;
  folder.name = name;
  folder.updatedAt = Date.now();
  await db.put('folders', folder);
  return folder;
}

// Removing a folder doesn't delete the notebooks inside it — they get
// promoted back to the top level (folderId = null). Deletion is destructive
// for the folder record only; the kid never loses notebook content this way.
export async function deleteFolder(id) {
  const db = await getDB();
  await runInTransaction(db, ['folders', 'notebooks'], 'readwrite', async (tx) => {
    const notebooks = await requestToPromise(tx.objectStore('notebooks').getAll());
    for (const nb of notebooks) {
      if (nb.folderId === id) {
        nb.folderId = null;
        nb.updatedAt = Date.now();
        tx.objectStore('notebooks').put(nb);
      }
    }
    tx.objectStore('folders').delete(id);
  });
}

// Move a single notebook into a folder (or back to the top level when
// folderId is null). updatedAt is bumped so the home screen reflects the
// reorder.
export async function setNotebookFolder(notebookId, folderId) {
  const db = await getDB();
  const nb = await db.get('notebooks', notebookId);
  if (!nb) return null;
  nb.folderId = folderId || null;
  nb.updatedAt = Date.now();
  await db.put('notebooks', nb);
  return nb;
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
