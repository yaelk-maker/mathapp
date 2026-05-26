import {
  listNotebooks,
  createNotebook,
  deleteNotebook,
  getNotebook,
  listTrash,
  restoreNotebookFromTrash,
  purgeNotebookFromTrash,
  purgeExpiredTrash,
  requestPersistentStorage,
  listFolders,
  getFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  setNotebookFolder,
  TRASH_TTL_MS
} from './db.js';
import { mountEditor } from './editor.js';
import {
  exportNotebooksToJSON,
  exportSingleNotebookToJSON,
  shareJSON,
  importNotebooksFromJSON,
  pickJSONFile,
  readJSONFile
} from './io/export.js';
import { confirmDialog, promptDialog, pickDialog, toast, notifySaveError } from './ui/dialog.js';
import { installSystemKeyboardBridge } from './ui/system-keyboard.js';

// Press-and-hold duration for the destructive notebook delete. Matches the
// 700ms transition on .notebook-card__delete--arming so the visual fill
// completes exactly when the action fires.
const DELETE_LONGPRESS_MS = 700;

const root = document.getElementById('app');

async function init() {
  // Ask for persistent storage so iPadOS doesn't evict the kid's homework.
  // iPadOS Safari usually rejects this on cold-load (no user activation
  // yet), so we also retry once on the first user gesture — the moment
  // she taps anything is sufficient activation. Persistence QA flagged
  // the cold-load rejection.
  await requestPersistentStorage();
  let retriedPersist = false;
  const retryPersist = async () => {
    if (retriedPersist) return;
    retriedPersist = true;
    document.removeEventListener('pointerdown', retryPersist, true);
    try { await requestPersistentStorage(); } catch (_) {}
  };
  document.addEventListener('pointerdown', retryPersist, true);

  // Drop trash entries older than 30 days before the first render so the kid
  // sees an accurate "נמחקו לאחרונה" count. Best-effort: a failure here
  // shouldn't block the home screen.
  try {
    await purgeExpiredTrash();
  } catch (err) {
    console.warn('Trash purge failed:', err);
  }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      // Force an update check on every page load. Safari is slow about
      // checking for new SW versions on its own (sometimes >24h),
      // which leaves installed PWAs stuck on stale shells for days
      // after a deploy. Calling reg.update() asks the browser to
      // re-fetch sw.js right now and install any new version it
      // finds. Cheap network request; doesn't block startup.
      reg.update().catch(() => {});
      // When a new service worker takes over this client (i.e. the
      // one we just registered called skipWaiting + clients.claim),
      // reload the page so the running tab swaps from old modules in
      // memory to the newly cached ones. Without this, the kid would
      // have to manually close and reopen the PWA twice to see a new
      // deploy. Guarded by a flag so a one-off SW restart can't loop.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  }

  // Bridge the iPadOS system keyboard with our layout — keeps modal dialogs
  // anchored above the on-screen keyboard and hides the in-app math keypad
  // while the kid types into a real <input>.
  installSystemKeyboardBridge();

  // Surface unhandled IDB / save-pipeline errors as a Hebrew toast instead
  // of letting them rot in the console. Without this the kid's homework can
  // silently fail to persist (quota exceeded, transaction abort) with no
  // user-visible signal.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const name = reason && reason.name;
    if (name === 'QuotaExceededError' || name === 'AbortError' ||
        name === 'TransactionInactiveError' || name === 'InvalidStateError') {
      notifySaveError();
    }
  });

  window.addEventListener('hashchange', render);
  try {
    await render();
  } catch (err) {
    console.error('Initial render failed:', err);
    await confirmDialog({
      title: 'תקלה בטעינה',
      body: 'לא הצלחנו לטעון את המחברות. נסי לרענן את הדף.',
      confirmLabel: 'אישור',
      cancelLabel: 'סגירה'
    });
  }
}

async function render() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#/notebook/')) {
    const id = hash.slice('#/notebook/'.length);
    await renderEditor(id);
  } else if (hash.startsWith('#/folder/')) {
    const id = hash.slice('#/folder/'.length);
    await renderFolder(id);
  } else if (hash === '#/trash') {
    await renderTrash();
  } else {
    await renderHome();
  }
}

async function renderHome() {
  const [notebooks, folders, trashEntries] = await Promise.all([
    listNotebooks(),
    listFolders(),
    listTrash()
  ]);
  const trashCount = trashEntries.length;
  // Top level shows notebooks NOT assigned to a folder. We also treat a
  // notebook whose folderId points at a since-deleted folder as top-level
  // — without this, a trashed-then-restored notebook from a gone folder
  // would be invisible (no folder card to enter and no top-level row).
  const folderIds = new Set(folders.map((f) => f.id));
  const rootNotebooks = notebooks.filter(
    (nb) => !nb.folderId || !folderIds.has(nb.folderId)
  );
  // Count notebooks per folder for the badge on each folder card. Same
  // dangling-folderId guard as above.
  const folderCounts = new Map();
  for (const nb of notebooks) {
    if (nb.folderId && folderIds.has(nb.folderId)) {
      folderCounts.set(nb.folderId, (folderCounts.get(nb.folderId) || 0) + 1);
    }
  }
  root.innerHTML = `
    <div class="screen">
      <h1>MathApp</h1>
      <div class="toolbar">
        <button class="btn" id="new-notebook">+ מחברת חדשה</button>
        <button class="btn btn--ghost" id="new-folder">+ תיקייה</button>
        <button class="btn btn--ghost" id="backup-all" ${
          notebooks.length === 0 ? 'disabled' : ''
        }>💾 גיבוי הכל</button>
        <button class="btn btn--ghost" id="restore-all">📥 שחזור</button>
        <button class="btn btn--ghost" id="open-trash">🗑️ נמחקו לאחרונה${
          trashCount > 0 ? ` (${trashCount})` : ''
        }</button>
      </div>
      <input type="search" class="search-input" id="notebook-search"
             placeholder="חיפוש לפי שם או תאריך..." aria-label="חיפוש מחברות"
             ${rootNotebooks.length === 0 && folders.length === 0 ? 'hidden' : ''}>
      <div id="folder-list-host">${renderFolderList(folders, folderCounts, '')}</div>
      <div id="notebook-list-host">${renderNotebookList(rootNotebooks, '', { folders })}</div>
    </div>
  `;

  document.getElementById('new-notebook').addEventListener('click', async () => {
    try {
      const count = (await listNotebooks()).length;
      const name = await promptDialog({
        title: 'מחברת חדשה',
        body: 'בחרי שם למחברת:',
        defaultValue: `מחברת ${count + 1}`,
        confirmLabel: 'יצירה'
      });
      if (name == null || !name.trim()) return;
      const nb = await createNotebook(name.trim());
      window.location.hash = `#/notebook/${nb.id}`;
    } catch (err) {
      console.error('Create notebook failed:', err);
      // Without this surface the click silently fails on the kid (notably
      // when IDB rejects the create transaction). A Hebrew toast at least
      // tells her something actually went wrong.
      toast('יצירת המחברת נכשלה — נסי שוב.', { kind: 'error', duration: 3600 });
    }
  });

  document.getElementById('new-folder').addEventListener('click', async () => {
    try {
      const count = (await listFolders()).length;
      const name = await promptDialog({
        title: 'תיקייה חדשה',
        body: 'בחרי שם לתיקייה:',
        defaultValue: `תיקייה ${count + 1}`,
        confirmLabel: 'יצירה'
      });
      if (name == null || !name.trim()) return;
      await createFolder(name.trim());
      toast('התיקייה נוצרה.');
      await render();
    } catch (err) {
      console.error('Create folder failed:', err);
      toast('יצירת התיקייה נכשלה — נסי שוב.', { kind: 'error', duration: 3600 });
    }
  });

  document.getElementById('open-trash').addEventListener('click', () => {
    window.location.hash = '#/trash';
  });

  const backupAllBtn = document.getElementById('backup-all');
  if (backupAllBtn) {
    backupAllBtn.addEventListener('click', async () => {
      if (backupAllBtn.disabled) return;
      try {
        // exportNotebooksToJSON already walks every notebook on the
        // device — pages, strokes, and referenced worksheet blobs —
        // and produces a single JSON the import path can read back
        // intact. Wrap it through shareJSON so the kid lands in the
        // iPadOS share sheet and can save to Files / send via mail.
        const data = await exportNotebooksToJSON();
        const stamp = new Date().toISOString().slice(0, 10);
        await shareJSON(data, `mathapp-all-${stamp}.json`);
      } catch (err) {
        console.error('Backup-all failed:', err);
        await confirmDialog({
          title: 'הגיבוי נכשל',
          body: err.message || 'נסי שוב מאוחר יותר.',
          confirmLabel: 'אישור',
          cancelLabel: 'סגירה'
        });
      }
    });
  }

  document.getElementById('restore-all').addEventListener('click', async () => {
    const file = await pickJSONFile();
    if (!file) return;
    try {
      const json = await readJSONFile(file);
      const count = await importNotebooksFromJSON(json);
      toast(`שוחזרו ${count} מחברות.`);
      await render();
    } catch (err) {
      console.error('Restore failed:', err);
      await confirmDialog({
        title: 'שחזור נכשל',
        body: err.message || 'הקובץ אינו תקין.',
        confirmLabel: 'אישור',
        cancelLabel: 'סגירה'
      });
    }
  });

  const searchInput = document.getElementById('notebook-search');
  const listHost = document.getElementById('notebook-list-host');
  const folderHost = document.getElementById('folder-list-host');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value;
      folderHost.innerHTML = renderFolderList(folders, folderCounts, q);
      listHost.innerHTML = renderNotebookList(rootNotebooks, q, { folders });
      wireFolderHandlers(folderHost);
      wireListHandlers(listHost, { folders });
    });
  }
  wireFolderHandlers(folderHost);
  wireListHandlers(listHost, { folders });
}

function renderNotebookList(notebooks, query, { folders = [], emptyMessage } = {}) {
  if (notebooks.length === 0) {
    return `<div class="empty-state">
              ${emptyMessage || 'אין עדיין מחברות.<br>לחץ על "+ מחברת חדשה" כדי להתחיל.'}
            </div>`;
  }
  const filtered = filterNotebooks(notebooks, query);
  if (filtered.length === 0) {
    return `<div class="empty-state">לא נמצאו מחברות תואמות.</div>`;
  }
  // Show the move-to-folder button only when there's somewhere to move TO —
  // i.e. at least one folder exists. Otherwise the button has nothing useful
  // to do and would just clutter the row.
  const showMove = (folders && folders.length > 0);
  return `<div class="notebook-list">
            ${filtered
              .map(
                (nb) => `
              <div class="notebook-card" data-id="${nb.id}" role="button" tabindex="0">
                <div class="notebook-card__main">
                  <div class="notebook-card__name">${escapeHtml(nb.name)}</div>
                  <div class="notebook-card__meta">${formatDate(nb.updatedAt)}</div>
                </div>
                ${showMove ? `<button class="notebook-card__action" data-move="${nb.id}" aria-label="העברה לתיקייה" title="העברה לתיקייה">📁</button>` : ''}
                <button class="notebook-card__action" data-save="${nb.id}" aria-label="גיבוי" title="גיבוי לדרייב">💾</button>
                <button class="notebook-card__delete" data-delete="${nb.id}"
                        aria-label="מחק" title="העברה לנמחקו לאחרונה">✕</button>
              </div>
            `
              )
              .join('')}
          </div>`;
}

// Folders list (home screen). A folder card opens the folder view and
// carries a small count badge so the kid sees how many notebooks live
// inside without having to enter it.
function renderFolderList(folders, folderCounts, query) {
  if (!folders || folders.length === 0) return '';
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? folders.filter((f) => (f.name || '').toLowerCase().includes(q))
    : folders;
  if (filtered.length === 0) return '';
  return `<div class="folder-list">
            ${filtered
              .map((f) => {
                const count = folderCounts.get(f.id) || 0;
                return `
              <div class="folder-card" data-folder-id="${f.id}" role="button" tabindex="0">
                <div class="folder-card__icon" aria-hidden="true">📁</div>
                <div class="folder-card__main">
                  <div class="folder-card__name">${escapeHtml(f.name)}</div>
                  <div class="folder-card__meta">${count} מחברות</div>
                </div>
                <button class="notebook-card__action" data-rename-folder="${f.id}" aria-label="שינוי שם" title="שינוי שם">✏️</button>
                <button class="notebook-card__delete" data-delete-folder="${f.id}"
                        aria-label="מחיקת תיקייה"
                        title="מחיקת תיקייה">✕</button>
              </div>
            `;
              })
              .join('')}
          </div>`;
}

function wireFolderHandlers(folderHost) {
  if (!folderHost) return;
  for (const card of folderHost.querySelectorAll('.folder-card')) {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-folder]') ||
          event.target.closest('[data-rename-folder]')) return;
      const id = card.getAttribute('data-folder-id');
      window.location.hash = `#/folder/${id}`;
    });
  }
  for (const btn of folderHost.querySelectorAll('[data-rename-folder]')) {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-rename-folder');
      const folder = await getFolder(id);
      if (!folder) return;
      const name = await promptDialog({
        title: 'שינוי שם תיקייה',
        body: 'בחרי שם חדש לתיקייה:',
        defaultValue: folder.name || '',
        confirmLabel: 'שמירה'
      });
      if (name == null || !name.trim()) return;
      await renameFolder(id, name.trim());
      toast('שם התיקייה עודכן.');
      await render();
    });
  }
  for (const btn of folderHost.querySelectorAll('[data-delete-folder]')) {
    wireFolderDeleteLongPress(btn);
  }
}

// Folder delete: tap → confirm dialog. The dialog body explicitly tells
// the kid the notebooks INSIDE will move back to the main screen, not
// vanish — folder deletion is non-destructive for content. The old
// long-press gate was removed (accessibility audit) because the
// confirm dialog alone is sufficient safety for a dedicated × button.
function wireFolderDeleteLongPress(btn) {
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const id = btn.getAttribute('data-delete-folder');
    const folder = await getFolder(id);
    if (!folder) return;
    const ok = await confirmDialog({
      title: 'מחיקת תיקייה',
      body: `למחוק את התיקייה "${folder.name}"? המחברות שבתוכה יחזרו למסך הראשי.`,
      confirmLabel: 'מחקי תיקייה',
      cancelLabel: 'ביטול',
      destructive: true
    });
    if (!ok) return;
    await deleteFolder(id);
    toast('התיקייה נמחקה.');
    await render();
  });
}

// Match against the notebook name AND the formatted date string. The kid
// could search "5.5" to find anything updated on May 5, or part of a name.
function filterNotebooks(notebooks, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return notebooks;
  return notebooks.filter((nb) => {
    const name = (nb.name || '').toLowerCase();
    const date = formatDate(nb.updatedAt).toLowerCase();
    return name.includes(q) || date.includes(q);
  });
}

function wireListHandlers(listHost, { folders = [] } = {}) {
  for (const card of listHost.querySelectorAll('.notebook-card')) {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete]') ||
          event.target.closest('[data-save]') ||
          event.target.closest('[data-move]')) return;
      const id = card.getAttribute('data-id');
      window.location.hash = `#/notebook/${id}`;
    });
  }

  for (const btn of listHost.querySelectorAll('[data-save]')) {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-save');
      const nb = await getNotebook(id);
      if (!nb) return;
      try {
        const data = await exportSingleNotebookToJSON(id);
        const stamp = new Date().toISOString().slice(0, 10);
        const safeName = (nb.name || 'notebook').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
        await shareJSON(data, `mathapp-${safeName}-${stamp}.json`);
      } catch (err) {
        console.error('Single-notebook backup failed:', err);
        await confirmDialog({
          title: 'הגיבוי נכשל',
          body: 'נסי שוב מאוחר יותר.',
          confirmLabel: 'אישור',
          cancelLabel: 'סגירה'
        });
      }
    });
  }

  for (const btn of listHost.querySelectorAll('[data-move]')) {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-move');
      const nb = await getNotebook(id);
      if (!nb) return;
      // Build the destination list every click — folders may have been
      // added/renamed since the home screen rendered. The "main screen"
      // option is rendered with a null id so the kid can lift the
      // notebook back out of its current folder.
      const allFolders = await listFolders();
      const options = [
        { id: null, label: '📄 המסך הראשי' },
        ...allFolders.map((f) => ({ id: f.id, label: `📁 ${f.name}` }))
      ];
      const target = await pickDialog({
        title: 'העברה לתיקייה',
        body: `לאן להעביר את "${nb.name}"?`,
        options,
        selectedId: nb.folderId || null,
        confirmLabel: 'העברה'
      });
      if (target === undefined) return;
      if ((nb.folderId || null) === (target || null)) return;
      await setNotebookFolder(id, target);
      toast(target
        ? `המחברת הועברה לתיקייה.`
        : `המחברת הועברה למסך הראשי.`);
      await render();
    });
  }

  for (const btn of listHost.querySelectorAll('[data-delete]')) {
    wireDeleteLongPress(btn);
  }
}

// Notebook delete is destructive — a Hebrew confirmation dialog is the
// safety net, and the 30-day trash gives a kid 30 days to undo. Was
// originally also gated behind a 700ms long-press, but that combined
// gesture is hard for a kid with reduced fine-motor control (the
// accessibility audit flagged it); the confirm dialog alone is enough
// of a safeguard for this UI affordance (the dedicated × button on the
// card the kid is intentionally interacting with).
function wireDeleteLongPress(btn) {
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const id = btn.getAttribute('data-delete');
    const nb = await getNotebook(id);
    if (!nb) return;
    const ok = await confirmDialog({
      title: 'העברה לנמחקו לאחרונה',
      body: `להעביר את "${nb.name}" לסל "נמחקו לאחרונה"? אפשר לשחזר אותה תוך 30 יום.`,
      confirmLabel: 'העבירי לסל',
      cancelLabel: 'ביטול'
    });
    if (!ok) return;
    await deleteNotebook(id);
    toast('המחברת הועברה לנמחקו לאחרונה.');
    await render();
  });
}

async function renderEditor(notebookId) {
  await mountEditor(root, notebookId);
}

// Folder view — listing of notebooks bound to a single folder, with a "new
// notebook" button that creates the new notebook inside this folder. If the
// folder id no longer resolves (deleted from another tab) we bounce home so
// the kid doesn't sit on an empty screen.
async function renderFolder(folderId) {
  const [folder, notebooks, folders] = await Promise.all([
    getFolder(folderId),
    listNotebooks(),
    listFolders()
  ]);
  if (!folder) {
    window.location.hash = '';
    return;
  }
  const folderNotebooks = notebooks.filter((nb) => nb.folderId === folderId);
  root.innerHTML = `
    <div class="screen">
      <div class="toolbar">
        <button class="btn btn--ghost" id="folder-back">→ חזרה</button>
      </div>
      <h1>📁 ${escapeHtml(folder.name)}</h1>
      <div class="toolbar">
        <button class="btn" id="new-notebook-in-folder">+ מחברת חדשה</button>
        <button class="btn btn--ghost" id="rename-folder">✏️ שינוי שם</button>
      </div>
      <input type="search" class="search-input" id="notebook-search"
             placeholder="חיפוש לפי שם או תאריך..." aria-label="חיפוש מחברות"
             ${folderNotebooks.length === 0 ? 'hidden' : ''}>
      <div id="notebook-list-host">${renderNotebookList(folderNotebooks, '', { folders, emptyMessage: 'התיקייה ריקה.<br>לחץ על "+ מחברת חדשה" כדי להתחיל.' })}</div>
    </div>
  `;

  document.getElementById('folder-back').addEventListener('click', () => {
    window.location.hash = '';
  });

  document.getElementById('new-notebook-in-folder').addEventListener('click', async () => {
    try {
      const count = folderNotebooks.length;
      const name = await promptDialog({
        title: 'מחברת חדשה',
        body: `יצירת מחברת חדשה בתיקייה "${folder.name}":`,
        defaultValue: `מחברת ${count + 1}`,
        confirmLabel: 'יצירה'
      });
      if (name == null || !name.trim()) return;
      const nb = await createNotebook(name.trim(), folderId);
      window.location.hash = `#/notebook/${nb.id}`;
    } catch (err) {
      console.error('Create notebook in folder failed:', err);
      toast('יצירת המחברת נכשלה — נסי שוב.', { kind: 'error', duration: 3600 });
    }
  });

  document.getElementById('rename-folder').addEventListener('click', async () => {
    const name = await promptDialog({
      title: 'שינוי שם תיקייה',
      body: 'בחרי שם חדש לתיקייה:',
      defaultValue: folder.name || '',
      confirmLabel: 'שמירה'
    });
    if (name == null || !name.trim()) return;
    await renameFolder(folderId, name.trim());
    toast('שם התיקייה עודכן.');
    await render();
  });

  const searchInput = document.getElementById('notebook-search');
  const listHost = document.getElementById('notebook-list-host');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      listHost.innerHTML = renderNotebookList(folderNotebooks, searchInput.value, { folders });
      wireListHandlers(listHost, { folders });
    });
  }
  wireListHandlers(listHost, { folders });
}

async function renderTrash() {
  const entries = await listTrash();
  root.innerHTML = `
    <div class="screen">
      <div class="toolbar">
        <button class="btn btn--ghost" id="trash-back">→ חזרה</button>
      </div>
      <h1>נמחקו לאחרונה</h1>
      <p class="trash-hint">מחברות נמחקות לצמיתות אחרי 30 יום.</p>
      <div id="trash-list-host">${renderTrashList(entries)}</div>
    </div>
  `;

  document.getElementById('trash-back').addEventListener('click', () => {
    window.location.hash = '';
  });

  wireTrashHandlers(document.getElementById('trash-list-host'));
}

function renderTrashList(entries) {
  if (entries.length === 0) {
    return `<div class="empty-state">סל "נמחקו לאחרונה" ריק.</div>`;
  }
  const now = Date.now();
  return `<div class="notebook-list">
            ${entries
              .map((entry) => {
                const nb = entry.notebook || {};
                const daysLeft = Math.max(
                  0,
                  Math.ceil((entry.deletedAt + TRASH_TTL_MS - now) / (24 * 60 * 60 * 1000))
                );
                return `
              <div class="notebook-card notebook-card--trash" data-id="${entry.id}">
                <div class="notebook-card__main">
                  <div class="notebook-card__name">${escapeHtml(nb.name || '')}</div>
                  <div class="notebook-card__meta">
                    נמחקה ב-${formatDate(entry.deletedAt)} ·
                    <span class="trash-days-left">נשארו ${daysLeft} ימים</span>
                  </div>
                </div>
                <button class="notebook-card__action" data-restore="${entry.id}"
                        aria-label="שחזור" title="שחזור">↩️</button>
                <button class="notebook-card__delete" data-purge="${entry.id}"
                        aria-label="מחק לתמיד"
                        title="מחק לתמיד">✕</button>
              </div>
            `;
              })
              .join('')}
          </div>`;
}

function wireTrashHandlers(listHost) {
  for (const btn of listHost.querySelectorAll('[data-restore]')) {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-restore');
      try {
        await restoreNotebookFromTrash(id);
        toast('המחברת שוחזרה.');
        await renderTrash();
      } catch (err) {
        console.error('Restore from trash failed:', err);
        toast('שחזור נכשל — נסי שוב.', { kind: 'error', duration: 3600 });
      }
    });
  }

  for (const btn of listHost.querySelectorAll('[data-purge]')) {
    wirePurgeLongPress(btn);
  }
}

// Purge from trash is genuinely irreversible — purgeNotebookFromTrash
// drops the snapshot blob bytes and there's no second safety net. The
// long-press was removed (accessibility audit) but the confirm dialog
// keeps its destructive styling and pointed wording so a deliberate
// tap is still required.
function wirePurgeLongPress(btn) {
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const id = btn.getAttribute('data-purge');
    const ok = await confirmDialog({
      title: 'מחיקה לצמיתות',
      body: 'למחוק את המחברת לתמיד? אי אפשר לשחזר אחרי הפעולה הזו.',
      confirmLabel: 'כן, מחקי לתמיד',
      cancelLabel: 'ביטול',
      destructive: true
    });
    if (!ok) return;
    await purgeNotebookFromTrash(id);
    await renderTrash();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}

init();
