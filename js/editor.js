// Notebook editor: a page is a vertical flow of blocks (worksheet images and
// work-grid blocks). The grid is a property of WorkBlocks only — it CANNOT
// bleed under a worksheet image. That is the architectural fix vs. ModMath.
//
// Phase 4 adds an Apple Pencil drawing layer: a single canvas overlay covers
// the entire page area so strokes can cross between worksheet and grid blocks.
// Strokes are stored per-page in IndexedDB.

import {
  listPages,
  getNotebook,
  savePage,
  renameNotebook,
  deleteBlob,
  listStrokesByPage,
  addStroke,
  deleteStrokeById,
  clearStrokesForPage
} from './db.js';
import { BLOCK, newWorkBlock } from './page-model.js';
import { renderWorkBlock, updateCell, updateCursor } from './render/grid.js';
import {
  renderWorksheetBlock,
  revokeWorksheetUrls,
  revokeBlobUrl
} from './render/worksheet.js';
import {
  sizeCanvas,
  renderStroke,
  renderStrokeIncremental,
  replayStrokes
} from './render/strokes.js';
import { renderKeypad, keyboardEventToCode } from './input/keypad.js';
import { uploadWorksheet } from './io/import.js';
import { attachPencilSurface } from './input/pencil.js';

const CHAR_KEYS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '+', '−', '×', '÷', '=', '.', '(', ')'
]);

const SAVE_DEBOUNCE_MS = 300;

const PEN_COLORS = ['#111111', '#0b6cf2', '#d12d2d', '#1f9c4a', '#e6a700'];

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

  if (!page.blocks.some((b) => b.type === BLOCK.WORK)) {
    page.blocks.push(newWorkBlock());
    await savePage(page);
  }

  const cursor = { r: 0, c: 0 };
  let activeWorkBlock = page.blocks.find((b) => b.type === BLOCK.WORK);
  let activeGrid = null;

  // Drawing state
  const strokes = await listStrokesByPage(page.id);
  let pencilEnabled = false;
  let eraserMode = false;
  let penColor = PEN_COLORS[0];
  let penWidth = 2.4;
  let canvas = null;
  let ctx = null;
  let detachPencil = null;
  const liveStrokes = new Map(); // strokeId -> stroke being drawn
  let liveDrawnPointCount = new Map(); // strokeId -> last drawn index

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
        <span class="editor__sep"></span>
        <button class="btn btn--ghost" id="toggle-pen">✏️ ציור</button>
        <span class="pen-tools" id="pen-tools" hidden>
          ${PEN_COLORS.map(
            (c, i) => `<button class="pen-color ${i === 0 ? 'pen-color--active' : ''}"
              style="background:${c}" data-color="${c}" aria-label="צבע"></button>`
          ).join('')}
          <button class="btn btn--ghost" id="toggle-eraser">🧽 מחק</button>
          <button class="btn btn--ghost" id="undo-stroke">↶ בטל</button>
          <button class="btn btn--ghost" id="clear-strokes">🗑️ נקה ציורים</button>
        </span>
      </div>
      <div class="editor__page-wrap">
        <div class="editor__page" id="page"></div>
        <canvas class="pencil-canvas" id="pencil-canvas"></canvas>
      </div>
      <div class="editor__keypad-host" id="keypad-host"></div>
    </div>
  `;

  document.getElementById('title').textContent = nb.name;
  document.getElementById('back-home').addEventListener('click', () => {
    flushSave();
    revokeWorksheetUrls();
    detachPencilIfAny();
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

  // Pencil toolbar wiring
  const penToolsEl = document.getElementById('pen-tools');
  const penToggleBtn = document.getElementById('toggle-pen');
  penToggleBtn.addEventListener('click', () => {
    pencilEnabled = !pencilEnabled;
    penToggleBtn.classList.toggle('btn--active', pencilEnabled);
    penToolsEl.hidden = !pencilEnabled;
    canvas.classList.toggle('pencil-canvas--active', pencilEnabled);
  });

  document.getElementById('toggle-eraser').addEventListener('click', (e) => {
    eraserMode = !eraserMode;
    e.currentTarget.classList.toggle('btn--active', eraserMode);
  });

  document.getElementById('undo-stroke').addEventListener('click', undoLastStroke);
  document.getElementById('clear-strokes').addEventListener('click', clearAllStrokes);

  for (const swatch of penToolsEl.querySelectorAll('.pen-color')) {
    swatch.addEventListener('click', () => {
      penColor = swatch.dataset.color;
      penToolsEl
        .querySelectorAll('.pen-color')
        .forEach((s) => s.classList.toggle('pen-color--active', s === swatch));
    });
  }

  const pageHost = document.getElementById('page');
  canvas = document.getElementById('pencil-canvas');
  ctx = canvas.getContext('2d');

  await renderBlocks();

  const keypad = renderKeypad({ onKey: handleKey });
  document.getElementById('keypad-host').appendChild(keypad);

  // Set up pencil surface and replay existing strokes
  setupPencilSurface();
  resizeAndReplay();

  const resizeObserver = new ResizeObserver(() => resizeAndReplay());
  resizeObserver.observe(pageHost);
  window.addEventListener('resize', resizeAndReplay);

  const keydownHandler = (event) => {
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
    window.removeEventListener('resize', resizeAndReplay);
    resizeObserver.disconnect();
    detachPencilIfAny();
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
        if (!activeWorkBlock) {
          activeWorkBlock = block;
          activeGrid = grid;
        }
      }
    }
    // Allow layout to settle, then resize the canvas to match content.
    requestAnimationFrame(() => resizeAndReplay());
  }

  // ---------- worksheet add / remove ----------

  async function addWorksheet({ capture }) {
    const ws = await uploadWorksheet({ capture });
    if (!ws) return;
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

  // ---------- pencil drawing ----------

  function setupPencilSurface() {
    detachPencilIfAny();
    detachPencil = attachPencilSurface(canvas, {
      isEnabled: () => pencilEnabled,
      // On desktop, mouse drawing is allowed (for testing). Touch (finger)
      // is always rejected — Pencil-only is the iPad UX.
      allowFinger: false,
      getColor: () => penColor,
      getWidth: () => penWidth,
      getEraserMode: () => eraserMode,
      onStrokeStart: ({ color, width, eraser, point }) => {
        const id = `stroke_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const stroke = {
          id,
          pageId: page.id,
          color,
          width,
          eraser,
          points: [point],
          createdAt: Date.now()
        };
        liveStrokes.set(id, stroke);
        liveDrawnPointCount.set(id, 0);
        strokes.push(stroke);
        // Render the initial dot
        const dpr = window.devicePixelRatio || 1;
        renderStroke(ctx, stroke, dpr);
        liveDrawnPointCount.set(id, 1);
        return id;
      },
      onStrokePoint: (id, point) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        stroke.points.push(point);
        const from = liveDrawnPointCount.get(id) || 0;
        const dpr = window.devicePixelRatio || 1;
        renderStrokeIncremental(ctx, stroke, from, dpr);
        liveDrawnPointCount.set(id, stroke.points.length);
      },
      onStrokeEnd: async (id) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        liveStrokes.delete(id);
        liveDrawnPointCount.delete(id);
        try {
          await addStroke(stroke);
        } catch (err) {
          console.error('Failed to save stroke:', err);
        }
      }
    });
  }

  function detachPencilIfAny() {
    if (detachPencil) {
      detachPencil();
      detachPencil = null;
    }
  }

  function resizeAndReplay() {
    if (!canvas || !pageHost) return;
    const wasEnabled = pencilEnabled;
    sizeCanvas(canvas, pageHost);
    replayStrokes(canvas, strokes);
    // Keep the canvas's pointer-events state in sync with mode.
    canvas.classList.toggle('pencil-canvas--active', wasEnabled);
  }

  async function undoLastStroke() {
    // Pop the most recently created non-live stroke.
    if (strokes.length === 0) return;
    const last = strokes[strokes.length - 1];
    if (liveStrokes.has(last.id)) return; // currently being drawn
    strokes.pop();
    try {
      await deleteStrokeById(last.id);
    } catch (err) {
      console.error('Undo delete failed:', err);
    }
    replayStrokes(canvas, strokes);
  }

  async function clearAllStrokes() {
    if (strokes.length === 0) return;
    if (!window.confirm('למחוק את כל הציורים בדף הזה?')) return;
    strokes.length = 0;
    await clearStrokesForPage(page.id);
    replayStrokes(canvas, strokes);
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
