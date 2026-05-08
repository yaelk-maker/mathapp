// Notebook editor: a page is a vertical flow of blocks (worksheet images and
// work-grid blocks). The grid is a property of WorkBlocks only — it CANNOT
// bleed under a worksheet image. That is the architectural fix vs. ModMath.

import {
  listPages,
  getNotebook,
  savePage,
  renameNotebook,
  deleteBlob
} from './db.js';
import { BLOCK, newWorkBlock } from './page-model.js';
import { renderWorkBlock, updateCell, updateCursor } from './render/grid.js';
import {
  renderWorksheetBlock,
  revokeWorksheetUrls,
  revokeBlobUrl
} from './render/worksheet.js';
import { renderKeypad, keyboardEventToCode } from './input/keypad.js';
import { uploadWorksheet } from './io/import.js';

const CHAR_KEYS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '+', '−', '×', '÷', '=', '.', '(', ')'
]);

const SAVE_DEBOUNCE_MS = 300;

export async function mountEditor(root, notebookId) {
  const nb = await getNotebook(notebookId);
  if (!nb) {
    window.location.hash = '';
    return;
  }
  const pages = await listPages(notebookId);
  if (pages.length === 0) {
    window.location.hash = '';
    return;
  }
  const page = pages[0];

  // Ensure the page has a work block. Phase 1 created empty pages; Phase 2+
  // requires a grid to write in.
  if (!page.blocks.some((b) => b.type === BLOCK.WORK)) {
    page.blocks.push(newWorkBlock());
    await savePage(page);
  }

  const cursor = { r: 0, c: 0 };
  let activeWorkBlock = page.blocks.find((b) => b.type === BLOCK.WORK);
  let activeGrid = null;

  root.innerHTML = `
    <div class="editor editor--full">
      <div class="editor__topbar">
        <button class="editor__back" id="back-home">→ חזרה</button>
        <h2 class="editor__title" id="title"></h2>
        <button class="btn btn--ghost" id="rename">שנה שם</button>
      </div>
      <div class="editor__actions">
        <button class="btn btn--ghost" id="upload-photo">📷 צלם דף</button>
        <button class="btn btn--ghost" id="upload-library">🖼️ בחר תמונה</button>
      </div>
      <div class="editor__page" id="page"></div>
      <div class="editor__keypad-host" id="keypad-host"></div>
    </div>
  `;

  document.getElementById('title').textContent = nb.name;
  document.getElementById('back-home').addEventListener('click', () => {
    flushSave();
    revokeWorksheetUrls();
    window.location.hash = '';
  });
  document.getElementById('rename').addEventListener('click', async () => {
    const name = window.prompt('שם חדש למחברת:', nb.name);
    if (!name || !name.trim() || name.trim() === nb.name) return;
    await renameNotebook(notebookId, name.trim());
    document.getElementById('title').textContent = name.trim();
    nb.name = name.trim();
  });

  document.getElementById('upload-photo').addEventListener('click', () =>
    addWorksheet({ capture: true })
  );
  document.getElementById('upload-library').addEventListener('click', () =>
    addWorksheet({ capture: false })
  );

  const pageHost = document.getElementById('page');

  await renderBlocks();

  const keypad = renderKeypad({ onKey: handleKey });
  document.getElementById('keypad-host').appendChild(keypad);

  const keydownHandler = (event) => {
    // Don't intercept if user is typing into a real input/dialog.
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const code = keyboardEventToCode(event);
    if (!code) return;
    event.preventDefault();
    handleKey(code);
  };
  document.addEventListener('keydown', keydownHandler);

  const cleanup = () => {
    document.removeEventListener('keydown', keydownHandler);
    flushSave();
    revokeWorksheetUrls();
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup, { once: true });

  // ---------- block rendering ----------

  async function renderBlocks() {
    pageHost.innerHTML = '';
    activeGrid = null;
    activeWorkBlock = null;
    for (const block of page.blocks) {
      if (block.type === BLOCK.WORKSHEET) {
        const el = await renderWorksheetBlock(block, {
          onDelete: (id) => removeBlock(id)
        });
        pageHost.appendChild(el);
      } else if (block.type === BLOCK.WORK) {
        const { wrapper, grid } = renderWorkBlock(block, {
          cursor,
          onCellTap: (r, c) => moveCursor(r, c)
        });
        pageHost.appendChild(wrapper);
        // Cache the first work block as the active one for input.
        if (!activeWorkBlock) {
          activeWorkBlock = block;
          activeGrid = grid;
        }
      }
    }
  }

  // ---------- worksheet add / remove ----------

  async function addWorksheet({ capture }) {
    const ws = await uploadWorksheet({ capture });
    if (!ws) return;
    // Insert worksheet BEFORE the first work block (so worksheet sits at top,
    // work area below). Falls back to "prepend" if no work block found.
    const workIndex = page.blocks.findIndex((b) => b.type === BLOCK.WORK);
    if (workIndex < 0) page.blocks.push(ws);
    else page.blocks.splice(workIndex, 0, ws);
    await savePage(page);
    await renderBlocks();
  }

  async function removeBlock(blockId) {
    const block = page.blocks.find((b) => b.id === blockId);
    if (!block) return;
    if (!window.confirm('להסיר את הדף הזה? המשבצות שלמטה יישמרו.')) return;
    page.blocks = page.blocks.filter((b) => b.id !== blockId);
    if (block.type === BLOCK.WORKSHEET && block.blobId) {
      revokeBlobUrl(block.blobId);
      await deleteBlob(block.blobId);
    }
    await savePage(page);
    await renderBlocks();
  }

  // ---------- input dispatch ----------

  function handleKey(code) {
    if (!activeWorkBlock) return;
    if (CHAR_KEYS.has(code)) {
      insertChar(code);
      return;
    }
    switch (code) {
      case 'BACKSPACE': backspace(); break;
      case 'LEFT': moveCursor(cursor.r, cursor.c - 1); break;
      case 'RIGHT': moveCursor(cursor.r, cursor.c + 1); break;
      case 'UP': moveCursor(cursor.r - 1, cursor.c); break;
      case 'DOWN': moveCursor(cursor.r + 1, cursor.c); break;
    }
  }

  function insertChar(ch) {
    const r = cursor.r;
    const c = cursor.c;
    activeWorkBlock.cells[`${r},${c}`] = { ch };
    updateCell(activeGrid, activeWorkBlock, r, c);
    if (c + 1 < activeWorkBlock.cols) moveCursor(r, c + 1);
    queueSave();
  }

  function backspace() {
    const r = cursor.r;
    const c = cursor.c;
    const here = activeWorkBlock.cells[`${r},${c}`];
    if (here && here.ch) {
      delete activeWorkBlock.cells[`${r},${c}`];
      updateCell(activeGrid, activeWorkBlock, r, c);
      queueSave();
      return;
    }
    if (c > 0) {
      const nc = c - 1;
      delete activeWorkBlock.cells[`${r},${nc}`];
      updateCell(activeGrid, activeWorkBlock, r, nc);
      moveCursor(r, nc);
      queueSave();
    }
  }

  function moveCursor(r, c) {
    if (!activeWorkBlock) return;
    const nr = clamp(r, 0, activeWorkBlock.rows - 1);
    const nc = clamp(c, 0, activeWorkBlock.cols - 1);
    if (nr === cursor.r && nc === cursor.c) return;
    const prev = { r: cursor.r, c: cursor.c };
    cursor.r = nr;
    cursor.c = nc;
    updateCursor(activeGrid, prev, cursor);
  }

  // ---------- debounced save ----------

  let saveTimer = null;
  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      doSave();
    }
  }
  async function doSave() {
    saveTimer = null;
    try {
      await savePage(page);
    } catch (err) {
      console.error('Save failed:', err);
    }
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
