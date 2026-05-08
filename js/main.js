import {
  listNotebooks,
  createNotebook,
  deleteNotebook,
  getNotebook,
  requestPersistentStorage
} from './db.js';
import { mountEditor } from './editor.js';

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
      </div>
      ${
        notebooks.length === 0
          ? `<div class="empty-state">
              אין עדיין מחברות.<br>
              לחץ על "+ מחברת חדשה" כדי להתחיל.
            </div>`
          : `<div class="notebook-list">
              ${notebooks
                .map(
                  (nb) => `
                <div class="notebook-card" data-id="${nb.id}" role="button" tabindex="0">
                  <div class="notebook-card__main">
                    <div class="notebook-card__name">${escapeHtml(nb.name)}</div>
                    <div class="notebook-card__meta">${formatDate(nb.updatedAt)}</div>
                  </div>
                  <button class="notebook-card__delete" data-delete="${nb.id}" aria-label="מחק">✕</button>
                </div>
              `
                )
                .join('')}
            </div>`
      }
    </div>
  `;

  document.getElementById('new-notebook').addEventListener('click', async () => {
    const count = (await listNotebooks()).length;
    const name = window.prompt('שם המחברת:', `מחברת ${count + 1}`);
    if (!name || !name.trim()) return;
    const nb = await createNotebook(name.trim());
    window.location.hash = `#/notebook/${nb.id}`;
  });

  for (const card of document.querySelectorAll('.notebook-card')) {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete]')) return;
      const id = card.getAttribute('data-id');
      window.location.hash = `#/notebook/${id}`;
    });
  }

  for (const btn of document.querySelectorAll('[data-delete]')) {
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
