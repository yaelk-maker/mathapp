import {
  listNotebooks,
  createNotebook,
  deleteNotebook,
  getNotebook,
  requestPersistentStorage
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

const root = document.getElementById('app');

async function init() {
  // Ask for persistent storage so iPadOS doesn't evict the kid's homework.
  await requestPersistentStorage();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  }

  window.addEventListener('hashchange', render);
  await render();
}

async function render() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#/notebook/')) {
    const id = hash.slice('#/notebook/'.length);
    await renderEditor(id);
  } else {
    await renderHome();
  }
}

async function renderHome() {
  const notebooks = await listNotebooks();
  root.innerHTML = `
    <div class="screen">
      <h1>MathApp</h1>
      <div class="toolbar">
        <button class="btn" id="new-notebook">+ מחברת חדשה</button>
        <button class="btn btn--ghost" id="restore-all">📥 שחזור</button>
      </div>
      <input type="search" class="search-input" id="notebook-search"
             placeholder="חיפוש לפי שם או תאריך..." aria-label="חיפוש מחברות"
             ${notebooks.length === 0 ? 'hidden' : ''}>
      <div id="notebook-list-host">${renderNotebookList(notebooks, '')}</div>
    </div>
  `;

  document.getElementById('new-notebook').addEventListener('click', async () => {
    const count = (await listNotebooks()).length;
    const name = window.prompt('שם המחברת:', `מחברת ${count + 1}`);
    if (!name || !name.trim()) return;
    const nb = await createNotebook(name.trim());
    window.location.hash = `#/notebook/${nb.id}`;
  });

  document.getElementById('restore-all').addEventListener('click', async () => {
    const file = await pickJSONFile();
    if (!file) return;
    try {
      const json = await readJSONFile(file);
      const count = await importNotebooksFromJSON(json);
      alert(`שוחזרו ${count} מחברות.`);
      await render();
    } catch (err) {
      console.error('Restore failed:', err);
      alert('שחזור נכשל: ' + (err.message || 'קובץ לא תקין'));
    }
  });

  const searchInput = document.getElementById('notebook-search');
  const listHost = document.getElementById('notebook-list-host');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      listHost.innerHTML = renderNotebookList(notebooks, searchInput.value);
      wireListHandlers(listHost);
    });
  }
  wireListHandlers(listHost);
}

function renderNotebookList(notebooks, query) {
  if (notebooks.length === 0) {
    return `<div class="empty-state">
              אין עדיין מחברות.<br>
              לחץ על "+ מחברת חדשה" כדי להתחיל.
            </div>`;
  }
  const filtered = filterNotebooks(notebooks, query);
  if (filtered.length === 0) {
    return `<div class="empty-state">לא נמצאו מחברות תואמות.</div>`;
  }
  return `<div class="notebook-list">
            ${filtered
              .map(
                (nb) => `
              <div class="notebook-card" data-id="${nb.id}" role="button" tabindex="0">
                <div class="notebook-card__main">
                  <div class="notebook-card__name">${escapeHtml(nb.name)}</div>
                  <div class="notebook-card__meta">${formatDate(nb.updatedAt)}</div>
                </div>
                <button class="notebook-card__action" data-save="${nb.id}" aria-label="גיבוי" title="גיבוי לדרייב">💾</button>
                <button class="notebook-card__delete" data-delete="${nb.id}" aria-label="מחק">✕</button>
              </div>
            `
              )
              .join('')}
          </div>`;
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

function wireListHandlers(listHost) {
  for (const card of listHost.querySelectorAll('.notebook-card')) {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete]') || event.target.closest('[data-save]')) return;
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
        alert('הגיבוי נכשל. נסה שוב.');
      }
    });
  }

  for (const btn of listHost.querySelectorAll('[data-delete]')) {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-delete');
      const nb = await getNotebook(id);
      if (!nb) return;
      const confirmed = window.confirm(`למחוק את "${nb.name}"? פעולה זו לא ניתנת לביטול.`);
      if (!confirmed) return;
      await deleteNotebook(id);
      await render();
    });
  }
}

async function renderEditor(notebookId) {
  await mountEditor(root, notebookId);
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
