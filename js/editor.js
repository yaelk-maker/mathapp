// Notebook editor: loads a notebook's first page, mounts the work block grid,
// the math keypad, and routes input.

import { listPages, getNotebook, savePage, renameNotebook } from './db.js';
import { BLOCK, newWorkBlock } from './page-model.js';
import { renderWorkBlock, updateCell, updateCursor } from './render/grid.js';
import { renderKeypad, keyboardEventToCode } from './input/keypad.js';

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

  // Ensure the page has at least one work block (Phase 1 created empty pages).
  if (!page.blocks || page.blocks.length === 0) {
    page.blocks = [newWorkBlock()];
    await savePage(page);
  }
  const workBlock = page.blocks.find((b) => b.type === BLOCK.WORK);
  if (!workBlock) {
    // No work block among existing blocks — append one.
    const wb = newWorkBlock();
    page.blocks.push(wb);
    await savePage(page);
  }
  const block = page.blocks.find((b) => b.type === BLOCK.WORK);

  const cursor = { r: 0, c: 0 };

  root.innerHTML = `
    <div class="editor editor--full">
      <div class="editor__topbar">
        <button class="editor__back" id="back-home">→ חזרה</button>
        <h2 class="editor__title" id="title"></h2>
        <button class="btn btn--ghost" id="rename">שנה שם</button>
      </div>
      <div class="editor__page" id="page"></div>
      <div class="editor__keypad-host" id="keypad-host"></div>
    </div>
  `;

  document.getElementById('title').textContent = nb.name;
  document.getElementById('back-home').addEventListener('click', () => {
    flushSave();
    window.location.hash = '';
  });
  document.getElementById('rename').addEventListener('click', async () => {
    const name = window.prompt('שם חדש למחברת:', nb.name);
    if (!name || !name.trim() || name.trim() === nb.name) return;
    await renameNotebook(notebookId, name.trim());
    document.getElementById('title').textContent = name.trim();
    nb.name = name.trim();
  });

  const pageHost = document.getElementById('page');
  const { wrapper, grid } = renderWorkBlock(block, {
    cursor,
    onCellTap: (r, c) => moveCursor(r, c)
  });
  pageHost.appendChild(wrapper);

  const keypad = renderKeypad({ onKey: handleKey });
  document.getElementById('keypad-host').appendChild(keypad);

  // Hardware keyboard support
  const keydownHandler = (event) => {
    const code = keyboardEventToCode(event);
    if (!code) return;
    event.preventDefault();
    handleKey(code);
  };
  document.addEventListener('keydown', keydownHandler);

  // Tear-down when route changes
  const cleanup = () => {
    document.removeEventListener('keydown', keydownHandler);
    flushSave();
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup, { once: true });

  // ---------- input dispatch ----------

  function handleKey(code) {
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
    block.cells[`${r},${c}`] = { ch };
    updateCell(grid, block, r, c);
    // Advance right if possible
    if (c + 1 < block.cols) moveCursor(r, c + 1);
    queueSave();
  }

  function backspace() {
    const r = cursor.r;
    const c = cursor.c;
    const here = block.cells[`${r},${c}`];
    if (here && here.ch) {
      delete block.cells[`${r},${c}`];
      updateCell(grid, block, r, c);
      queueSave();
      return;
    }
    // Move left and clear that cell (if any)
    if (c > 0) {
      const nc = c - 1;
      delete block.cells[`${r},${nc}`];
      updateCell(grid, block, r, nc);
      moveCursor(r, nc);
      queueSave();
    }
  }

  function moveCursor(r, c) {
    const nr = clamp(r, 0, block.rows - 1);
    const nc = clamp(c, 0, block.cols - 1);
    if (nr === cursor.r && nc === cursor.c) return;
    const prev = { r: cursor.r, c: cursor.c };
    cursor.r = nr;
    cursor.c = nc;
    updateCursor(grid, prev, cursor);
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
