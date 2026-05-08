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
  compositeWidth,
  findOccupyingAnchor,
  newFractionCell,
  newPowCell,
  newSqrtCell,
  newNRootCell
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
import { renderHebrewKeypad } from './input/hebrew-keypad.js';
import { uploadWorksheet } from './io/import.js';
import { attachPencilSurface } from './input/pencil.js';

const CHAR_KEYS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '+', '−', '×', '÷', '=', '.', '(', ')', '%',
  'x', 'y', 'a', 'b',
  '<', '>'
]);

// Inside a fraction slot we can't open a nested composite (slots are plain
// strings), but the kid still wants to write things like "x²" or "√2" in a
// numerator. Map POW/SQRT presses to inline unicode marks so they appear in
// the slot text. POW cycles ²→³→⁴ when pressed repeatedly so multiple
// powers are reachable without a dedicated key.
const SUPERSCRIPT_DIGITS = ['²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const SUPERSCRIPT_NEXT = new Map(
  SUPERSCRIPT_DIGITS.map((s, i) => [s, SUPERSCRIPT_DIGITS[(i + 1) % SUPERSCRIPT_DIGITS.length]])
);

const COMPOSITE_KEYS = {
  FRAC: () => newFractionCell(),
  POW: () => newPowCell(),
  // a² shortcut — pre-fills the exponent so the kid doesn't have to type
  // '2' after every square. Treated like POW for promotion of an adjacent
  // atom into the base; insertComposite skips entering the exp slot when
  // exp is already filled (see special-case in insertComposite).
  SQUARE: () => newPowCell('', '2'),
  SQRT: () => newSqrtCell(),
  NROOT: () => newNRootCell()
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

  // Keypad mode: 'math' (default) or 'hebrew'. Hebrew mode swaps in the
  // letter keypad and routes presses into the active work block's grid
  // (one Hebrew letter per cell, just like math digits).
  let keypadMode = 'math';

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
  // Block offset captured at stroke start. The block can't move during a
  // single stroke (the user is drawing on it), so caching at start lets us
  // translate incoming points to block-relative coords without re-measuring
  // the DOM on every pointermove.
  const liveStrokeOffsets = new Map(); // strokeId -> { x, y }
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
        <button class="btn btn--ghost" id="add-work">➕ אזור פתרון</button>
        <button class="btn btn--ghost" id="toggle-split">🔀 פיצול</button>
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
        <div class="pen-mode-indicator">✏️ מצב ציור פעיל</div>
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
  document.getElementById('add-work').addEventListener('click', () => addWorkBlock());

  // Split-view toggle: in split mode the worksheet sits next to the work
  // block (instead of above). Persisted in localStorage so the preference
  // sticks across sessions.
  const editorEl = root.querySelector('.editor--full');
  const splitToggleBtn = document.getElementById('toggle-split');
  let splitMode = localStorage.getItem('mathapp.splitMode') === '1';
  editorEl.classList.toggle('editor--split', splitMode);
  splitToggleBtn.classList.toggle('btn--active', splitMode);
  splitToggleBtn.addEventListener('click', () => {
    splitMode = !splitMode;
    localStorage.setItem('mathapp.splitMode', splitMode ? '1' : '0');
    editorEl.classList.toggle('editor--split', splitMode);
    splitToggleBtn.classList.toggle('btn--active', splitMode);
    // Layout changed — re-measure the canvas so strokes still render.
    requestAnimationFrame(() => resizeAndReplay());
  });

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

  const keypadHost = document.getElementById('keypad-host');

  function mountKeypad() {
    keypadHost.innerHTML = '';
    if (keypadMode === 'hebrew') {
      keypadHost.appendChild(renderHebrewKeypad({ onKey: handleHebrewKey }));
    } else {
      keypadHost.appendChild(renderKeypad({ onKey: handleKey }));
    }
  }

  function setKeypadMode(mode) {
    if (mode === keypadMode) return;
    keypadMode = mode;
    mountKeypad();
    requestAnimationFrame(() => resizeAndReplay());
  }

  mountKeypad();

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
    // Only allow deleting a work block if there's at least one other to fall
    // back to — protects the kid from ending up with no grid at all.
    const workBlockCount = page.blocks.filter((b) => b.type === BLOCK.WORK).length;
    const canDeleteWork = workBlockCount > 1;
    for (const block of page.blocks) {
      let el = null;
      if (block.type === BLOCK.WORKSHEET) {
        el = await renderWorksheetBlock(block, {
          onDelete: (id) => removeBlock(id)
        });
      } else if (block.type === BLOCK.WORK) {
        const { wrapper, grid } = renderWorkBlock(block, {
          cursor,
          onCellTap: (r, c) => {
            // Tapping a cell switches focus to that work block (if there
            // are several) and back to the math keypad.
            if (activeWorkBlock !== block) {
              activeWorkBlock = block;
              activeGrid = grid;
              cursor.r = 0; cursor.c = 0; cursor.slot = null;
            }
            if (keypadMode !== 'math') setKeypadMode('math');
            moveCursor(r, c);
          },
          onDelete: canDeleteWork ? (id) => removeBlock(id) : undefined
        });
        el = wrapper;
        if (!activeWorkBlock) {
          activeWorkBlock = block;
          activeGrid = grid;
        }
      }
      // Any other block type (e.g. legacy 'text' from the short-lived
      // textbox feature) renders nothing — text is now typed directly on
      // the grid via the Hebrew keypad.
      if (el) {
        attachBlockChrome(el, block);
        applyBlockOffset(el, block);
        pageHost.appendChild(el);
      }
    }
    // The previously active work block may have been deleted or resized;
    // clamp the cursor so it always lands on a real cell of whichever
    // block is now active.
    if (activeWorkBlock) {
      cursor.r = clamp(cursor.r, 0, activeWorkBlock.rows - 1);
      cursor.c = clamp(cursor.c, 0, activeWorkBlock.cols - 1);
      const anchor = findOccupyingAnchor(activeWorkBlock, cursor.r, cursor.c);
      if (anchor) { cursor.r = anchor.r; cursor.c = anchor.c; }
      if (cursor.slot && !activeWorkBlock.cells[`${cursor.r},${cursor.c}`]) {
        cursor.slot = null;
      }
    } else {
      cursor.slot = null;
    }
    // Allow layout to settle, then resize the canvas to match content.
    requestAnimationFrame(() => resizeAndReplay());
  }

  // Drag handle on every block + resize handle on work blocks. Called from
  // renderBlocks AND from rerenderActiveGrid (the latter rebuilds the
  // wrapper after a fraction widens, and would otherwise drop the handles).
  function attachBlockChrome(el, block) {
    attachBlockDragHandle(el, block);
    if (block.type === BLOCK.WORK) attachWorkBlockResize(el, block);
  }

  // Apply a block's persisted horizontal offset (set by drag-to-reposition).
  // Vertical position is still controlled by the document flow / reorder.
  function applyBlockOffset(el, block) {
    const x = Number(block.xOffset) || 0;
    el.style.transform = x ? `translateX(${x}px)` : '';
    el.dataset.xOffset = String(x);
  }

  // Add a small drag handle button to the top-start of the block. Pointer-
  // event-driven reorder: while dragging, we lift the block visually and
  // show a thin blue indicator at the prospective drop position. On release
  // we swap into page.blocks at that index. Disabled while pen mode is on
  // so the canvas's pointer-events: auto doesn't fight the handle.
  function attachBlockDragHandle(el, block) {
    el.classList.add('block');
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'block__handle';
    handle.title = 'גרור כדי לסדר מחדש';
    handle.setAttribute('aria-label', 'גרור כדי לסדר מחדש');
    handle.textContent = '⋮⋮';
    // Don't let the handle steal focus from a textarea/cell.
    handle.addEventListener('mousedown', (e) => e.preventDefault());
    handle.addEventListener('pointerdown', (e) => {
      if (pencilEnabled) return;
      startBlockDrag(e, el, block, handle);
    });
    el.appendChild(handle);
  }

  // Resize handle on the bottom-right of a work block. Drag it to add/remove
  // rows and columns — the kid uses this to shrink the work area when their
  // solution is short, so the next worksheet image isn't pushed way down by
  // a long blank grid. Snap to whole cells; persist on pointerup.
  function attachWorkBlockResize(wrapper, block) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'workblock__resize';
    handle.title = 'גרור כדי לשנות גודל';
    handle.setAttribute('aria-label', 'שנה גודל');
    handle.textContent = '⤡';
    handle.addEventListener('mousedown', (e) => e.preventDefault());

    let state = null;

    handle.addEventListener('pointerdown', (e) => {
      if (pencilEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const grid = wrapper.querySelector('.grid');
      const cellSize =
        parseFloat(getComputedStyle(grid).getPropertyValue('--cell-size')) || 38;
      state = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origRows: block.rows,
        origCols: block.cols,
        cellSize,
        changed: false
      };
      wrapper.classList.add('workblock--resizing');
    });

    handle.addEventListener('pointermove', (e) => {
      if (!state || e.pointerId !== state.pointerId) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      const newCols = clamp(
        state.origCols + Math.round(dx / state.cellSize),
        4,
        40
      );
      const newRows = clamp(
        state.origRows + Math.round(dy / state.cellSize),
        2,
        40
      );
      if (newCols !== block.cols || newRows !== block.rows) {
        block.cols = newCols;
        block.rows = newRows;
        state.changed = true;
        // Live preview only for the active grid (cheap, in-place rerender).
        // For other work blocks we wait for pointerup to avoid full
        // page-rerender storms during the drag.
        if (activeWorkBlock === block) rerenderActiveGrid();
      }
    });

    const onUp = async (e) => {
      if (!state || e.pointerId !== state.pointerId) return;
      const wasChanged = state.changed;
      state = null;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      wrapper.classList.remove('workblock--resizing');
      if (!wasChanged) return;

      // Drop any cells that no longer fit, including composites whose
      // span would extend past the new column count. Strokes anchored to
      // this block stay — their points are block-relative, so the user can
      // still see what was drawn even when the grid shrinks below them.
      const newCells = {};
      for (const [key, cell] of Object.entries(block.cells)) {
        const [r, c] = key.split(',').map(Number);
        const w = compositeWidth(cell);
        if (r < block.rows && c + w <= block.cols) newCells[key] = cell;
      }
      block.cells = newCells;
      // Clamp the cursor inside the new bounds.
      cursor.r = clamp(cursor.r, 0, block.rows - 1);
      cursor.c = clamp(cursor.c, 0, block.cols - 1);
      if (cursor.slot && !block.cells[`${cursor.r},${cursor.c}`]) {
        cursor.slot = null;
      }
      await savePage(page);
      await renderBlocks();
    };
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);

    wrapper.appendChild(handle);
  }

  let dragState = null;
  function startBlockDrag(downEvent, el, block, handle) {
    downEvent.preventDefault();
    handle.setPointerCapture(downEvent.pointerId);

    const blocksContainer = pageHost;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const baseXOffset = Number(block.xOffset) || 0;

    dragState = {
      pointerId: downEvent.pointerId,
      block,
      el,
      handle,
      startX,
      startY,
      baseXOffset,
      dx: 0,
      dy: 0,
      moved: false,
      indicator: null,
      targetIndex: null
    };

    el.classList.add('block--dragging');

    const onMove = (e) => {
      if (e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragState.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      dragState.moved = true;
      dragState.dx = dx;
      dragState.dy = dy;
      el.style.transform = `translate(${baseXOffset + dx}px, ${dy}px)`;

      // Compute where the block would land vertically — compare the
      // pointer's clientY against the midpoint of each sibling block in the
      // CURRENT order (excluding the one being dragged) and find the slot.
      const siblings = [...blocksContainer.children].filter(
        (n) => n !== el && n.dataset.blockId
      );
      let targetIndex = siblings.length;
      for (let i = 0; i < siblings.length; i += 1) {
        const r = siblings[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          targetIndex = i;
          break;
        }
      }
      showDropIndicator(siblings, targetIndex);
      dragState.targetIndex = targetIndex;
    };

    const onUp = async (e) => {
      if (e.pointerId !== dragState.pointerId) return;
      const ds = dragState;
      dragState = null;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.classList.remove('block--dragging');
      removeDropIndicator();

      if (!ds.moved) {
        // No real movement — restore the original transform so the
        // persisted xOffset stays applied.
        applyBlockOffset(el, ds.block);
        return;
      }

      // Persist the horizontal offset. Clamp so the kid can't shove a
      // block far off-screen and lose track of it. The page content is
      // centered, so we allow ±half the page width as a rough bound.
      const pageRect = pageContent.getBoundingClientRect();
      const maxX = Math.max(0, pageRect.width / 2);
      const newXOffset = clamp(ds.baseXOffset + ds.dx, -maxX, maxX);
      const xChanged = newXOffset !== (Number(ds.block.xOffset) || 0);
      if (xChanged) ds.block.xOffset = newXOffset;

      // Reorder vertically.
      let orderChanged = false;
      if (ds.targetIndex != null) {
        const others = page.blocks.filter((b) => b.id !== ds.block.id);
        others.splice(ds.targetIndex, 0, ds.block);
        orderChanged = !others.every((b, i) => b === page.blocks[i]);
        if (orderChanged) page.blocks = others;
      }

      if (xChanged || orderChanged) {
        await savePage(page);
        await renderBlocks();
      } else {
        // Nothing to commit — just snap the visual back to the persisted
        // offset (clears the in-drag transform).
        applyBlockOffset(el, ds.block);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function showDropIndicator(siblings, index) {
    removeDropIndicator();
    const indicator = document.createElement('div');
    indicator.className = 'block-drop-indicator';
    if (index >= siblings.length) {
      pageHost.appendChild(indicator);
    } else {
      pageHost.insertBefore(indicator, siblings[index]);
    }
    if (dragState) dragState.indicator = indicator;
  }

  function removeDropIndicator() {
    pageHost.querySelectorAll('.block-drop-indicator').forEach((n) => n.remove());
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
    const confirmText =
      block.type === BLOCK.WORK
        ? 'להסיר את אזור הפתרון הזה?'
        : 'להסיר את הדף הזה?';
    if (!window.confirm(confirmText)) return;

    // Delete any strokes that belong to this block. Strokes anchored to the
    // block by id (the modern path) are removed directly. Legacy unanchored
    // strokes are matched by spatial overlap with the block's vertical
    // extent — same fallback as before, kept so old notebooks still
    // self-clean when the user removes a block.
    {
      const figure = pageHost.querySelector(`[data-block-id="${blockId}"]`);
      let yTop = -Infinity;
      let yBottom = -Infinity;
      if (figure && pageContent) {
        const figRect = figure.getBoundingClientRect();
        const contentRect = pageContent.getBoundingClientRect();
        yTop = figRect.top - contentRect.top;
        yBottom = figRect.bottom - contentRect.top;
      }
      // Wait for any in-flight saves so we don't race with stroke writes.
      await Promise.allSettled([...pendingStrokeSaves]);
      const toDelete = strokes.filter((s) => {
        if (s.blockId === blockId) return true;
        if (!s.blockId && yTop !== -Infinity) {
          return (s.points || []).some((p) => p.y >= yTop && p.y <= yBottom);
        }
        return false;
      });
      for (const stroke of toDelete) {
        try { await deleteStrokeById(stroke.id); } catch (_) {}
      }
      const deletedIds = new Set(toDelete.map((s) => s.id));
      for (let i = strokes.length - 1; i >= 0; i -= 1) {
        if (deletedIds.has(strokes[i].id)) strokes.splice(i, 1);
      }
    }

    page.blocks = page.blocks.filter((b) => b.id !== blockId);
    if (block.type === BLOCK.WORKSHEET && block.blobId) {
      revokeBlobUrl(block.blobId);
      await deleteBlob(block.blobId);
    }
    await savePage(page);
    await renderBlocks();
  }

  async function addWorkBlock() {
    page.blocks.push(newWorkBlock());
    await savePage(page);
    await renderBlocks();
  }

  // Move a block within the page.blocks array, then save and rerender.
  async function reorderBlock(blockId, newIndex) {
    const fromIndex = page.blocks.findIndex((b) => b.id === blockId);
    if (fromIndex < 0) return;
    const clamped = Math.max(0, Math.min(page.blocks.length - 1, newIndex));
    if (fromIndex === clamped) return;
    const [block] = page.blocks.splice(fromIndex, 1);
    page.blocks.splice(clamped, 0, block);
    await savePage(page);
    await renderBlocks();
  }

  // ---------- pencil drawing ----------

  // Translate a canvas-relative point into a block-relative one by
  // subtracting the block's top-left offset. Pressure (p) and timestamp (t)
  // pass through unchanged.
  function relativizePoint(point, offset) {
    return {
      ...point,
      x: point.x - (offset?.x || 0),
      y: point.y - (offset?.y || 0)
    };
  }

  // Find which rendered block contains a given canvas-relative point.
  // Returns { id, offset } or null when the point falls in a gap (above the
  // first block, between blocks, or below the last). Such strokes are saved
  // as page-anchored.
  function findBlockAtPoint(point) {
    if (!pageHost || !pageContent) return null;
    const contentRect = pageContent.getBoundingClientRect();
    for (const el of pageHost.children) {
      if (!el.dataset || !el.dataset.blockId) continue;
      const rect = el.getBoundingClientRect();
      const top = rect.top - contentRect.top;
      const bottom = rect.bottom - contentRect.top;
      if (point.y >= top && point.y <= bottom) {
        return {
          id: el.dataset.blockId,
          offset: { x: rect.left - contentRect.left, y: top }
        };
      }
    }
    return null;
  }

  // Read the current top-left of a block within canvas coords. Returns null
  // when the block is no longer rendered (caller decides what to do —
  // replay treats null as "skip orphan stroke").
  function getBlockOffset(blockId) {
    if (!blockId) return null;
    const el = pageHost && pageHost.querySelector(`[data-block-id="${blockId}"]`);
    if (!el || !pageContent) return null;
    const rect = el.getBoundingClientRect();
    const contentRect = pageContent.getBoundingClientRect();
    return { x: rect.left - contentRect.left, y: rect.top - contentRect.top };
  }

  // Used by replayStrokes — translates a stored stroke into its current
  // canvas position. Legacy unanchored strokes return null (render in place);
  // strokes whose block has been removed return false (skip rendering).
  function offsetForStroke(stroke) {
    if (!stroke.blockId) return null;
    const off = getBlockOffset(stroke.blockId);
    return off || false;
  }

  function setupPencilSurface() {
    detachPencilIfAny();
    detachPencil = attachPencilSurface(canvas, {
      isEnabled: () => pencilEnabled,
      // Drawing is gated entirely by pen-mode toggle. When pen mode is OFF
      // the canvas has pointer-events: none and finger taps fall through
      // to the grid for typing. When pen mode is ON, ANY pointer (Apple
      // Pencil, finger, or mouse on desktop) draws — needed because not
      // every kid has a Pencil.
      allowFinger: true,
      getColor: () => penColor,
      getWidth: () => penWidth,
      getEraserMode: () => eraserMode,
      onStrokeStart: ({ color, width, eraser, point }) => {
        const id = `stroke_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        // Anchor the stroke to whichever block contains its first point.
        // Points are then stored block-relative so the stroke moves with
        // the block when it's reordered. If the start falls in the gap
        // between blocks, the stroke is page-anchored (blockId = null).
        const found = findBlockAtPoint(point);
        const blockId = found ? found.id : null;
        const blockOffset = found ? found.offset : { x: 0, y: 0 };
        liveStrokeOffsets.set(id, blockOffset);
        const relPoint = relativizePoint(point, blockOffset);
        const stroke = {
          id,
          pageId: page.id,
          blockId,
          color,
          width,
          eraser,
          points: [relPoint],
          createdAt: Date.now()
        };
        liveStrokes.set(id, stroke);
        liveDrawnPointCount.set(id, 0);
        strokes.push(stroke);
        // Render the initial dot translated by the cached block offset.
        const dpr = window.devicePixelRatio || 1;
        renderStroke(ctx, stroke, dpr, blockOffset);
        liveDrawnPointCount.set(id, 1);
        return id;
      },
      onStrokePoint: (id, point) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        const blockOffset = liveStrokeOffsets.get(id) || { x: 0, y: 0 };
        stroke.points.push(relativizePoint(point, blockOffset));
        const from = liveDrawnPointCount.get(id) || 0;
        const dpr = window.devicePixelRatio || 1;
        renderStrokeIncremental(ctx, stroke, from, dpr, blockOffset);
        liveDrawnPointCount.set(id, stroke.points.length);
      },
      onStrokeEnd: (id) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        liveStrokes.delete(id);
        liveDrawnPointCount.delete(id);
        liveStrokeOffsets.delete(id);
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
    replayStrokes(canvas, strokes, offsetForStroke);
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
    replayStrokes(canvas, strokes, offsetForStroke);
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
    replayStrokes(canvas, strokes, offsetForStroke);
  }

  // ---------- input dispatch ----------

  // Hebrew presses go into the same work-block grid the math keypad targets
  // — one Hebrew letter per cell. Hebrew is RTL: typing advances the cursor
  // LEFT, SPACE advances LEFT, NEWLINE drops to the next row's RIGHTMOST
  // column, and BACKSPACE deletes the most recently typed cell (which is to
  // the RIGHT of the current cursor position). Arrow keys still navigate
  // freely so the kid can fix a single letter without deleting through.
  function handleHebrewKey(code) {
    if (code === 'TOGGLE_KEYPAD') {
      setKeypadMode('math');
      return;
    }
    if (!activeWorkBlock) return;
    switch (code) {
      case 'BACKSPACE': backspaceRTL(); return;
      case 'SPACE': moveCursor(cursor.r, cursor.c - 1); return;
      case 'NEWLINE':
        moveCursor(cursor.r + 1, activeWorkBlock.cols - 1);
        return;
      case 'LEFT': arrowHorizontal(-1); return;
      case 'RIGHT': arrowHorizontal(1); return;
      case 'UP': arrowVertical(-1); return;
      case 'DOWN': arrowVertical(1); return;
      default:
        // Single Hebrew letter or punctuation — insert as a one-char atom
        // and advance the cursor LEFT so the next letter lands to the
        // left of this one (RTL flow).
        insertCharRTL(code);
    }
  }

  // Same as insertChar but advances the cursor LEFT (toward c=0) instead of
  // right. Used by the Hebrew keypad so typed text reads right-to-left.
  function insertCharRTL(ch) {
    const r = cursor.r;
    const c = cursor.c;
    activeWorkBlock.cells[`${r},${c}`] = { ch };
    updateCell(activeGrid, activeWorkBlock, r, c);
    if (c > 0) moveCursor(r, c - 1);
    queueSave();
  }

  // RTL backspace: the most recently typed cell sits to the RIGHT of the
  // cursor (because typing advances left). Delete it, then place the cursor
  // there so the next press overwrites in place.
  function backspaceRTL() {
    const r = cursor.r;
    const c = cursor.c;
    const here = getCellAt(r, c);
    if (here) {
      delete activeWorkBlock.cells[`${r},${c}`];
      updateCell(activeGrid, activeWorkBlock, r, c);
      queueSave();
      return;
    }
    if (c + 1 < activeWorkBlock.cols) {
      const nc = c + 1;
      delete activeWorkBlock.cells[`${r},${nc}`];
      updateCell(activeGrid, activeWorkBlock, r, nc);
      moveCursor(r, nc);
      queueSave();
    }
  }

  function handleKey(code) {
    if (code === 'TOGGLE_KEYPAD') {
      setKeypadMode('hebrew');
      return;
    }
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
      // Space in math mode advances the cursor right — it doesn't insert a
      // visible space character, since math cells are single atoms.
      case 'SPACE': arrowHorizontal(1); break;
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
        cursor.slot = null;
      } else {
        return appendToSlot(cell, r, c, cursor.slot, ch);
      }
    }

    // Defensive: cursor without slot but landed on a composite cell.
    // Enter the first slot rather than overwriting the composite.
    if (isComposite(cell)) {
      const firstSlot = compositeSlots(cell)[0];
      if (firstSlot) {
        cursor.slot = firstSlot;
        return appendToSlot(cell, r, c, firstSlot, ch);
      }
    }

    activeWorkBlock.cells[`${r},${c}`] = { ch };
    updateCell(activeGrid, activeWorkBlock, r, c);
    if (c + 1 < activeWorkBlock.cols) moveCursor(r, c + 1);
    queueSave();
  }

  // Append a char into a composite slot, expanding the cell's width if the
  // slot grows. Refuses to expand when the next column is taken (directly
  // or by another wider anchor) or beyond the grid edge — and flashes the
  // cell so the kid knows the press didn't take.
  function appendToSlot(cell, r, c, slot, ch) {
    const oldWidth = compositeWidth(cell);
    const tentativeValue = (cell[slot] || '') + ch;
    const hypothetical = { ...cell, [slot]: tentativeValue };
    const newWidth = compositeWidth(hypothetical);

    if (newWidth > oldWidth) {
      for (let i = oldWidth; i < newWidth; i += 1) {
        const nextC = c + i;
        if (nextC >= activeWorkBlock.cols) {
          flashRefuse(r, c);
          return;
        }
        if (activeWorkBlock.cells[`${r},${nextC}`]) {
          flashRefuse(r, c);
          return;
        }
        if (findOccupyingAnchor(activeWorkBlock, r, nextC)) {
          flashRefuse(r, c);
          return;
        }
      }
    }

    cell[slot] = tentativeValue;
    if (newWidth !== oldWidth) {
      rerenderActiveGrid();
    } else {
      repaintCell(r, c);
    }
    queueSave();
  }

  // POW pressed inside a slot: cycle the trailing superscript digit (²→³→⁴…)
  // if present, otherwise append ². The kid taps once for square, twice for
  // cube, etc., without us needing a separate key per power.
  function appendSuperscriptToSlot(cell, r, c, slot) {
    const current = cell[slot] || '';
    const last = current.slice(-1);
    if (SUPERSCRIPT_NEXT.has(last)) {
      const next = SUPERSCRIPT_NEXT.get(last);
      return replaceSlotTail(cell, r, c, slot, current.slice(0, -1) + next);
    }
    return appendCharToSlot(cell, r, c, slot, '²');
  }

  // Append a literal char to a slot — same width-expansion guard as
  // appendToSlot. Kept separate from insertChar's typing path so the kid
  // can't end up in the "cursor.slot but cell isn't composite" branch.
  function appendCharToSlot(cell, r, c, slot, ch) {
    return appendToSlot(cell, r, c, slot, ch);
  }

  // For superscript cycling: replace the slot value entirely (length stays
  // the same so we never need to re-check width or rerender the grid).
  function replaceSlotTail(cell, r, c, slot, newValue) {
    cell[slot] = newValue;
    repaintCell(r, c);
    queueSave();
  }

  // Briefly flash a cell red to indicate "no room — input refused".
  function flashRefuse(r, c) {
    if (!activeGrid) return;
    const el = activeGrid.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
    if (!el) return;
    el.classList.add('cell--refuse');
    setTimeout(() => el.classList.remove('cell--refuse'), 260);
  }

  function insertComposite(template) {
    const r = cursor.r;
    const c = cursor.c;
    if (cursor.slot) {
      // Composites can't be nested into a slot's string model, but POW and
      // SQRT are common enough inside fractions that we handle them inline:
      // POW appends/cycles a unicode superscript digit, SQRT prepends a √.
      // FRAC inside a slot still falls through to "exit and create new".
      const cell = getCellAt(r, c);
      if (isComposite(cell)) {
        if (template.type === 'pow') {
          return appendSuperscriptToSlot(cell, r, c, cursor.slot);
        }
        if (template.type === 'sqrt') {
          return appendCharToSlot(cell, r, c, cursor.slot, '√');
        }
      }
      // FRAC (or any unhandled composite): exit and create new outside.
      exitComposite(1);
      return insertComposite(template);
    }

    // Special UX for exponents: when typed right after an atom, "promote"
    // that atom into the base of a new pow cell. Two cases:
    //  - cursor is on an empty cell with an atom immediately to its left
    //    (the typical "type x, then xⁿ" flow)
    //  - cursor sits ON an atom (user navigated back onto it)
    // SQUARE arrives here as a pow template with exp pre-filled to '2'.
    // When that's the case we keep the pre-fill and skip entering the exp
    // slot so the cursor lands ready for the next atom.
    if (template.type === 'pow') {
      const presetExp = template.exp || '';
      const enterSlot = presetExp ? null : 'exp';
      const here = getCellAt(r, c);
      if (here && here.ch != null) {
        const promoted = { type: 'pow', base: here.ch, exp: presetExp };
        activeWorkBlock.cells[`${r},${c}`] = promoted;
        updateCell(activeGrid, activeWorkBlock, r, c);
        if (enterSlot) moveCursorTo(r, c, enterSlot);
        else if (c + 1 < activeWorkBlock.cols) moveCursor(r, c + 1);
        queueSave();
        return;
      }
      if (c > 0) {
        const prev = getCellAt(r, c - 1);
        if (prev && prev.ch != null) {
          const promoted = { type: 'pow', base: prev.ch, exp: presetExp };
          activeWorkBlock.cells[`${r},${c - 1}`] = promoted;
          updateCell(activeGrid, activeWorkBlock, r, c - 1);
          if (enterSlot) moveCursorTo(r, c - 1, enterSlot);
          // No prev-atom advance for SQUARE: the cursor already sits at c
          // (just past the promoted base), which is exactly where the next
          // character should land.
          queueSave();
          return;
        }
      }
    }

    const existing = getCellAt(r, c);
    // If the cursor is on a cell with content, advance past its full width
    // (wide composites take more than one column) and refuse if the next
    // position is also taken — never silently overwrite an existing cell.
    let targetR = r;
    let targetC = c;
    if (existing) {
      targetC = c + compositeWidth(existing);
      if (
        targetC >= activeWorkBlock.cols ||
        activeWorkBlock.cells[`${targetR},${targetC}`] ||
        findOccupyingAnchor(activeWorkBlock, targetR, targetC)
      ) {
        flashRefuse(r, c);
        return;
      }
    } else if (findOccupyingAnchor(activeWorkBlock, targetR, targetC)) {
      // The current cell IS occupied (visually rendered as part of a wider
      // composite to the left). Refuse rather than corrupt the model.
      flashRefuse(r, c);
      return;
    }
    activeWorkBlock.cells[`${targetR},${targetC}`] = template;
    const slots = compositeSlots(template);
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
          const oldWidth = compositeWidth(here);
          here[cursor.slot] = current.slice(0, -1);
          const newWidth = compositeWidth(here);
          if (newWidth !== oldWidth) rerenderActiveGrid();
          else repaintCell(r, c);
          queueSave();
          return;
        }
        // Slot is empty.
        if (isCompositeEmpty(here)) {
          // Collapse the empty composite. Re-render in case it was wide.
          const wasWide = compositeWidth(here) > 1;
          delete activeWorkBlock.cells[`${r},${c}`];
          cursor.slot = null;
          if (wasWide) rerenderActiveGrid();
          else repaintCell(r, c);
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
    if (dir > 0) {
      // Skip past the full width of the current cell (wide fractions).
      const here = getCellAt(cursor.r, cursor.c);
      const advance = here ? compositeWidth(here) : 1;
      moveCursor(cursor.r, cursor.c + advance);
    } else {
      // Going left: if (c - 1) is occupied by a wider anchor, jump to the
      // anchor's column rather than land on a phantom cell.
      const targetC = cursor.c - 1;
      const occupyingAnchor = findOccupyingAnchor(activeWorkBlock, cursor.r, targetC);
      moveCursor(cursor.r, occupyingAnchor ? occupyingAnchor.c : targetC);
    }
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
      } else if (cell.type === 'nroot') {
        // index sits as a superscript on the √ (above the radicand line):
        // ↑ in radicand → index; ↓ in index → radicand.
        if (dir < 0) nextIdx = idx === 1 ? 0 : -1;
        else nextIdx = idx === 0 ? 1 : -1;
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
    // Skip past the FULL width of the composite — wide fractions occupy
    // multiple columns, and the cursor must land outside their span.
    const here = getCellAt(cursor.r, cursor.c);
    const w = here ? compositeWidth(here) : 1;
    const targetC = dir > 0 ? cursor.c + w : cursor.c - 1;
    if (targetC < 0 || targetC >= activeWorkBlock.cols) {
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
    let nr = clamp(r, 0, activeWorkBlock.rows - 1);
    let nc = clamp(c, 0, activeWorkBlock.cols - 1);

    // If the target cell is occupied by a multi-cell composite anchored
    // elsewhere, redirect to the anchor — there's no rendered cell at the
    // requested position.
    const occupyingAnchor = findOccupyingAnchor(activeWorkBlock, nr, nc);
    if (occupyingAnchor) {
      nr = occupyingAnchor.r;
      nc = occupyingAnchor.c;
    }

    const target = getCellAt(nr, nc);

    let effectiveSlot = slot || null;
    if (effectiveSlot != null && !isComposite(target)) {
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

  // Re-render just the active work block in place. Used when a fraction's
  // width changes (cells need to be added/removed to match the new span).
  function rerenderActiveGrid() {
    if (!activeGrid || !activeWorkBlock) return;
    const wrapper = activeGrid.parentElement; // .workblock
    if (!wrapper || !wrapper.parentElement) return;
    const parent = wrapper.parentElement;
    const workBlockCount = page.blocks.filter((b) => b.type === BLOCK.WORK).length;
    const canDeleteWork = workBlockCount > 1;
    const { wrapper: newWrapper, grid: newGrid } = renderWorkBlock(activeWorkBlock, {
      cursor,
      onCellTap: (r, c) => moveCursor(r, c),
      onDelete: canDeleteWork ? (id) => removeBlock(id) : undefined
    });
    // Reattach drag + resize handles. Without this they vanish whenever a
    // fraction widens (or any other in-place rerender).
    attachBlockChrome(newWrapper, activeWorkBlock);
    applyBlockOffset(newWrapper, activeWorkBlock);
    parent.replaceChild(newWrapper, wrapper);
    activeGrid = newGrid;
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
