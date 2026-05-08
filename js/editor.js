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
import {
  BLOCK,
  newWorkBlock,
  isComposite,
  compositeSlots,
  isCompositeEmpty,
  newFractionCell,
  newPowCell,
  newSqrtCell
} from './page-model.js';
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
  '+', '−', '×', '÷', '=', '.', '(', ')',
  'x', 'y', 'a', 'b',
  '<', '>', '≤', '≥'
]);

const COMPOSITE_KEYS = {
  FRAC: () => newFractionCell(),
  POW: () => newPowCell(),
  SQRT: () => newSqrtCell()
};

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

  // cursor.slot is null when in main grid; otherwise the active slot name of
  // a composite cell at (r, c) — e.g. 'num', 'den', 'base', 'exp', 'radicand'.
  const cursor = { r: 0, c: 0, slot: null };
  let activeWorkBlock = page.blocks.find((b) => b.type === BLOCK.WORK);
  let activeGrid = null;

  // Drawing state
  const strokes = await listStrokesByPage(page.id);
  let pencilEnabled = false;
  let eraserMode = false;
  let penColor = PEN_COLORS[0];
  const penWidth = 2.4;
  let canvas = null;
  let ctx = null;
  let detachPencil = null;
  const liveStrokes = new Map(); // strokeId -> stroke being drawn
  const liveDrawnPointCount = new Map(); // strokeId -> last drawn index
  // In-flight stroke save promises. Cleanup must await these so the kid never
  // loses a stroke by tapping "back" right after lifting the Pencil.
  const pendingStrokeSaves = new Set();

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
        <button class="btn btn--ghost" id="print-page">🖨️ הדפסה</button>
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
      <div class="editor__page" id="page-scroll">
        <div class="editor__page-content" id="page-content">
          <div id="page"></div>
          <canvas class="pencil-canvas" id="pencil-canvas"></canvas>
        </div>
      </div>
      <div class="editor__keypad-host" id="keypad-host"></div>
    </div>
  `;

  document.getElementById('title').textContent = nb.name;
  document.getElementById('back-home').addEventListener('click', async () => {
    detachPencilIfAny();
    // Wait for both pending page saves AND in-flight stroke saves before
    // navigating away — otherwise a typed digit or a lifted Pencil can be
    // lost between the action and the IDB write committing.
    await Promise.all([
      flushSave(),
      Promise.allSettled([...pendingStrokeSaves])
    ]);
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

  // Print: snapshot the canvas as an <img> in place so drawings make it
  // into the PDF (browsers don't reliably print absolute-positioned canvas).
  let printSnapshotImg = null;
  function injectPrintSnapshot() {
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      printSnapshotImg = document.createElement('img');
      printSnapshotImg.className = 'pencil-print-snapshot';
      printSnapshotImg.src = dataUrl;
      printSnapshotImg.style.position = 'absolute';
      printSnapshotImg.style.top = canvas.style.top;
      printSnapshotImg.style.left = canvas.style.left;
      printSnapshotImg.style.width = canvas.style.width;
      printSnapshotImg.style.height = canvas.style.height;
      printSnapshotImg.style.pointerEvents = 'none';
      canvas.parentElement.appendChild(printSnapshotImg);
      canvas.style.visibility = 'hidden';
    } catch (err) {
      console.warn('Could not snapshot canvas for print:', err);
    }
  }
  function removePrintSnapshot() {
    if (printSnapshotImg) {
      printSnapshotImg.remove();
      printSnapshotImg = null;
    }
    if (canvas) canvas.style.visibility = '';
  }
  window.addEventListener('beforeprint', injectPrintSnapshot);
  window.addEventListener('afterprint', removePrintSnapshot);

  document.getElementById('print-page').addEventListener('click', () => {
    flushSave();
    window.print();
  });

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
  const pageContent = document.getElementById('page-content');
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
    window.removeEventListener('beforeprint', injectPrintSnapshot);
    window.removeEventListener('afterprint', removePrintSnapshot);
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
      onStrokeEnd: (id) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        liveStrokes.delete(id);
        liveDrawnPointCount.delete(id);
        const savePromise = addStroke(stroke).catch((err) => {
          console.error('Failed to save stroke:', err);
        });
        pendingStrokeSaves.add(savePromise);
        savePromise.finally(() => pendingStrokeSaves.delete(savePromise));
      }
    });
  }

  function detachPencilIfAny() {
    if (detachPencil) {
      detachPencil();
      detachPencil = null;
    }
  }

  let resizeAndReplayPending = false;
  function resizeAndReplay() {
    if (!canvas || !pageHost) return;
    // Never wipe the canvas mid-stroke — the destination-out / lineWidth
    // state belongs to the live stroke; clearing now would cause artifacts
    // and lose the live stroke's drawn pixels until the next replay.
    if (liveStrokes.size > 0) {
      if (!resizeAndReplayPending) {
        resizeAndReplayPending = true;
        const retry = () => {
          resizeAndReplayPending = false;
          if (liveStrokes.size > 0) {
            // Still drawing — try again after a frame.
            requestAnimationFrame(retry);
          } else {
            resizeAndReplay();
          }
        };
        requestAnimationFrame(retry);
      }
      return;
    }
    // Size against the content wrapper (whose size is driven by the blocks).
    // The canvas lives inside the scrollable page so it scrolls with content.
    sizeCanvas(canvas, pageContent);
    replayStrokes(canvas, strokes);
    canvas.classList.toggle('pencil-canvas--active', pencilEnabled);
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
    // Snapshot the IDs we're committing to delete. Any new strokes that
    // arrive after this snapshot (e.g. a pointerup completing right now)
    // are intentionally preserved.
    const idsToDelete = strokes.map((s) => s.id);
    const idSet = new Set(idsToDelete);
    // Wait for any in-flight stroke saves to finish first — otherwise a
    // mid-flight save could re-add a stroke we just cleared from IDB.
    await Promise.allSettled([...pendingStrokeSaves]);
    for (const id of idsToDelete) {
      try { await deleteStrokeById(id); } catch (_) {}
    }
    // Drop only the strokes we snapshotted; keep any added during the await.
    for (let i = strokes.length - 1; i >= 0; i -= 1) {
      if (idSet.has(strokes[i].id)) strokes.splice(i, 1);
    }
    replayStrokes(canvas, strokes);
  }

  // ---------- input dispatch ----------

  function handleKey(code) {
    if (!activeWorkBlock) return;
    if (CHAR_KEYS.has(code)) {
      insertChar(code);
      return;
    }
    if (COMPOSITE_KEYS[code]) {
      insertComposite(COMPOSITE_KEYS[code]());
      return;
    }
    switch (code) {
      case 'BACKSPACE': backspace(); break;
      case 'LEFT': arrowHorizontal(-1); break;
      case 'RIGHT': arrowHorizontal(1); break;
      case 'UP': arrowVertical(-1); break;
      case 'DOWN': arrowVertical(1); break;
      case 'EXIT': exitComposite(1); break;
    }
  }

  function getCellAt(r, c) {
    return activeWorkBlock.cells[`${r},${c}`];
  }

  function insertChar(ch) {
    const r = cursor.r;
    const c = cursor.c;
    const cell = getCellAt(r, c);

    if (cursor.slot) {
      if (!isComposite(cell)) {
        // Stray slot state — clear and fall through.
        cursor.slot = null;
      } else {
        cell[cursor.slot] = (cell[cursor.slot] || '') + ch;
        repaintCell(r, c);
        queueSave();
        return;
      }
    }

    // Defensive: cursor without slot but landed on a composite cell.
    // Enter the first slot rather than overwriting the composite.
    if (isComposite(cell)) {
      const firstSlot = compositeSlots(cell)[0];
      if (firstSlot) {
        cursor.slot = firstSlot;
        cell[firstSlot] = (cell[firstSlot] || '') + ch;
        repaintCell(r, c);
        queueSave();
        return;
      }
    }

    activeWorkBlock.cells[`${r},${c}`] = { ch };
    updateCell(activeGrid, activeWorkBlock, r, c);
    if (c + 1 < activeWorkBlock.cols) moveCursor(r, c + 1);
    queueSave();
  }

  function insertComposite(template) {
    const r = cursor.r;
    const c = cursor.c;
    if (cursor.slot) {
      // Composites cannot be nested in this version. Exit current slot first.
      exitComposite(1);
      return insertComposite(template);
    }

    // Special UX for exponents: when typed right after an atom, "promote"
    // that atom into the base of a new pow cell. Two cases:
    //  - cursor is on an empty cell with an atom immediately to its left
    //    (the typical "type x, then xⁿ" flow)
    //  - cursor sits ON an atom (user navigated back onto it)
    if (template.type === 'pow') {
      const here = getCellAt(r, c);
      if (here && here.ch != null) {
        const promoted = { type: 'pow', base: here.ch, exp: '' };
        activeWorkBlock.cells[`${r},${c}`] = promoted;
        updateCell(activeGrid, activeWorkBlock, r, c);
        moveCursorTo(r, c, 'exp');
        queueSave();
        return;
      }
      if (c > 0) {
        const prev = getCellAt(r, c - 1);
        if (prev && prev.ch != null) {
          const promoted = { type: 'pow', base: prev.ch, exp: '' };
          activeWorkBlock.cells[`${r},${c - 1}`] = promoted;
          updateCell(activeGrid, activeWorkBlock, r, c - 1);
          moveCursorTo(r, c - 1, 'exp');
          queueSave();
          return;
        }
      }
    }

    const existing = getCellAt(r, c);
    // If user is on an empty cell, place composite there. If cell has content,
    // advance to next column first.
    let targetR = r;
    let targetC = c;
    if (existing) {
      if (c + 1 >= activeWorkBlock.cols) return; // no room
      targetC = c + 1;
    }
    activeWorkBlock.cells[`${targetR},${targetC}`] = template;
    const slots = compositeSlots(template);
    // Repaint the new composite cell, then move cursor (which will repaint
    // again with the active slot highlight).
    updateCell(activeGrid, activeWorkBlock, targetR, targetC);
    moveCursorTo(targetR, targetC, slots[0] || null);
    queueSave();
  }

  function backspace() {
    const r = cursor.r;
    const c = cursor.c;
    const here = getCellAt(r, c);

    if (cursor.slot) {
      // Editing a composite slot.
      if (!isComposite(here)) {
        cursor.slot = null;
      } else {
        const current = here[cursor.slot] || '';
        if (current.length > 0) {
          here[cursor.slot] = current.slice(0, -1);
          repaintCell(r, c);
          queueSave();
          return;
        }
        // Slot is empty.
        if (isCompositeEmpty(here)) {
          // Collapse and remove the empty composite — return cursor to its
          // grid position with no slot.
          delete activeWorkBlock.cells[`${r},${c}`];
          cursor.slot = null;
          repaintCell(r, c);
          queueSave();
          return;
        }
        // Slot empty but other slots have content: jump to previous slot.
        const slots = compositeSlots(here);
        const idx = slots.indexOf(cursor.slot);
        if (idx > 0) {
          cursor.slot = slots[idx - 1];
          repaintCell(r, c);
        }
        return;
      }
    }

    // Atomic backspace: clear current cell, or move left and clear.
    if (here) {
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

  function arrowHorizontal(dir) {
    if (cursor.slot) {
      // Inside a composite slot, ←/→ exit the composite to that side.
      // autoEnterSlot:false means we don't immediately re-enter the next
      // composite — the user is trying to leave the current one.
      exitComposite(dir);
      return;
    }
    moveCursor(cursor.r, cursor.c + dir);
  }

  function arrowVertical(dir) {
    if (cursor.slot) {
      const cell = getCellAt(cursor.r, cursor.c);
      if (!isComposite(cell)) {
        cursor.slot = null;
        moveCursor(cursor.r + dir, cursor.c, { autoEnterSlot: false });
        return;
      }
      const slots = compositeSlots(cell);
      const idx = slots.indexOf(cursor.slot);
      const lastIdx = slots.length - 1;
      let nextIdx = -1;
      if (cell.type === 'fraction') {
        // num is "above" den in display: ↑ in den → num; ↓ in num → den.
        if (dir < 0) nextIdx = idx > 0 ? idx - 1 : -1;
        else nextIdx = idx < lastIdx ? idx + 1 : -1;
      } else if (cell.type === 'pow') {
        // exp is "above" base in display: ↑ in base → exp; ↓ in exp → base.
        if (dir < 0) nextIdx = idx === 0 ? 1 : -1;
        else nextIdx = idx === 1 ? 0 : -1;
      }
      // sqrt/abs (single slot) always exit on ↑/↓.

      if (nextIdx === -1) {
        cursor.slot = null;
        moveCursor(cursor.r + dir, cursor.c, { autoEnterSlot: false });
      } else {
        cursor.slot = slots[nextIdx];
        repaintCell(cursor.r, cursor.c);
      }
      return;
    }
    moveCursor(cursor.r + dir, cursor.c);
  }

  function exitComposite(dir) {
    if (!cursor.slot) return;
    cursor.slot = null;
    if (dir === 0) {
      repaintCell(cursor.r, cursor.c);
      return;
    }
    const targetC = cursor.c + (dir > 0 ? 1 : -1);
    if (targetC < 0 || targetC >= activeWorkBlock.cols) {
      // No room to move — at least clear the slot highlight in place.
      repaintCell(cursor.r, cursor.c);
      return;
    }
    moveCursor(cursor.r, targetC, { autoEnterSlot: false });
  }

  function moveCursor(r, c, options) {
    if (!activeWorkBlock) return;
    const nr = clamp(r, 0, activeWorkBlock.rows - 1);
    const nc = clamp(c, 0, activeWorkBlock.cols - 1);
    moveCursorTo(nr, nc, null, options);
  }

  // Reconcile cursor position + slot. Called for both navigation and
  // tap-to-position. autoEnterSlot defaults to true so tapping a composite
  // lands you inside its first slot — but exit paths pass false so the user
  // isn't immediately re-entered into an adjacent composite they were trying
  // to step past.
  function moveCursorTo(r, c, slot, options = {}) {
    if (!activeWorkBlock) return;
    const { autoEnterSlot = true } = options;
    const nr = clamp(r, 0, activeWorkBlock.rows - 1);
    const nc = clamp(c, 0, activeWorkBlock.cols - 1);
    const target = getCellAt(nr, nc);

    let effectiveSlot = slot || null;
    if (effectiveSlot != null && !isComposite(target)) {
      // Asked for a slot but the cell isn't composite — discard.
      effectiveSlot = null;
    } else if (effectiveSlot == null && autoEnterSlot && isComposite(target)) {
      effectiveSlot = compositeSlots(target)[0] || null;
    }

    if (nr === cursor.r && nc === cursor.c && effectiveSlot === cursor.slot) return;

    const prev = { r: cursor.r, c: cursor.c, slot: cursor.slot };
    cursor.r = nr;
    cursor.c = nc;
    cursor.slot = effectiveSlot;
    updateCursor(activeGrid, prev, cursor, getCellAt);
  }

  function repaintCell(r, c) {
    const isCursorHere = cursor.r === r && cursor.c === c;
    updateCell(activeGrid, activeWorkBlock, r, c, isCursorHere ? cursor.slot : null);
  }

  // ---------- debounced save ----------

  let saveTimer = null;
  // Track all pending save promises so cleanup can await them and we never
  // lose a typed digit by tearing down the editor between debounce-fire
  // and the IDB transaction completing.
  const pendingPageSaves = new Set();

  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }

  // Returns a Promise that resolves once any pending save has been awaited.
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      doSave(); // adds to pendingPageSaves
    }
    return Promise.allSettled([...pendingPageSaves]);
  }

  function doSave() {
    saveTimer = null;
    const p = (async () => {
      try {
        await savePage(page);
      } catch (err) {
        console.error('Save failed:', err);
      }
    })();
    pendingPageSaves.add(p);
    p.finally(() => pendingPageSaves.delete(p));
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
