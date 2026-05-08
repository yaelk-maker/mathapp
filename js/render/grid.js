// Renders a WorkBlock as a CSS-grid. Every cell is 1 logical position.
// Atoms hold one character. Composite cells (fractions, exponents, sqrt, abs)
// render with custom inner DOM but still occupy exactly one grid position.
// Math is LTR even when the page UI is RTL.

import {
  getCell,
  cellKey,
  isComposite,
  compositeSlots,
  compositeWidth,
  occupiedCellSet
} from '../page-model.js';

export function renderWorkBlock(block, options = {}) {
  const { onCellTap, cursor, onDelete, onMoveRow } = options;

  const wrapper = document.createElement('div');
  wrapper.className = 'workblock';
  wrapper.setAttribute('dir', 'ltr');
  wrapper.dataset.blockId = block.id;

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.setProperty('--rows', block.rows);
  grid.style.setProperty('--cols', block.cols);

  // Cells covered by a multi-cell composite anchored elsewhere — skip them
  // so the anchor's `grid-column: span N` actually has the columns to occupy.
  const occupied = occupiedCellSet(block);

  for (let r = 0; r < block.rows; r += 1) {
    for (let c = 0; c < block.cols; c += 1) {
      if (occupied.has(`${r},${c}`)) continue;

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;

      const value = getCell(block, r, c);
      const width = compositeWidth(value);

      // Explicit grid placement so skipping cells doesn't shift the row.
      cell.style.gridRowStart = r + 1;
      cell.style.gridColumnStart = c + 1;
      if (width > 1) {
        cell.style.gridColumnEnd = `span ${width}`;
        cell.classList.add('cell--span');
      }

      const isCursor = cursor && cursor.r === r && cursor.c === c;
      paintCell(cell, value, isCursor ? cursor.slot : null);
      if (isCursor) cell.classList.add('cell--cursor');

      grid.appendChild(cell);
    }
  }

  // Long-press on a non-empty cell starts a "move row" drag — the kid can
  // grab a finished calculation row and drop it elsewhere in this work
  // block. Suppresses the cursor-positioning click that would otherwise
  // fire on pointerup. Tracked at the grid level so it can both block the
  // click and gate dragging on whether the row actually has content.
  let suppressNextClick = false;
  if (onMoveRow) attachRowDrag(grid, block, onMoveRow, () => {
    suppressNextClick = true;
  });

  if (onCellTap) {
    grid.addEventListener('click', (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const target = event.target.closest('.cell');
      if (!target) return;
      const r = Number(target.dataset.r);
      const c = Number(target.dataset.c);
      onCellTap(r, c);
    });
    grid.addEventListener('pointerdown', () => {
      suppressNextClick = false;
    });
  }

  wrapper.appendChild(grid);

  // Delete button only renders when the caller supplies an onDelete — the
  // editor passes it only for non-last work blocks so the kid can never
  // delete their way into a notebook with no place to type.
  if (onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'workblock__delete';
    del.textContent = '✕';
    del.title = 'הסר אזור פתרון';
    del.setAttribute('aria-label', 'הסר אזור פתרון');
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(block.id);
    });
    wrapper.appendChild(del);
  }

  return { wrapper, grid };
}

export function updateCell(grid, block, r, c, activeSlot = null) {
  const cell = grid.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
  if (!cell) return;
  paintCell(cell, getCell(block, r, c), activeSlot);
}

export function updateCursor(grid, prevCursor, nextCursor, getCellAt) {
  if (prevCursor) {
    const prev = grid.querySelector(
      `.cell[data-r="${prevCursor.r}"][data-c="${prevCursor.c}"]`
    );
    if (prev) {
      prev.classList.remove('cell--cursor');
      // Clear active-slot highlight from old composite cell
      if (getCellAt) paintCell(prev, getCellAt(prevCursor.r, prevCursor.c), null);
    }
  }
  if (nextCursor) {
    const next = grid.querySelector(
      `.cell[data-r="${nextCursor.r}"][data-c="${nextCursor.c}"]`
    );
    if (next) {
      next.classList.add('cell--cursor');
      if (getCellAt) {
        paintCell(next, getCellAt(nextCursor.r, nextCursor.c), nextCursor.slot || null);
      }
    }
  }
}

// Render the contents of a single cell DOM node based on the value object.
function paintCell(cellEl, value, activeSlot) {
  cellEl.innerHTML = '';
  cellEl.classList.remove('cell--composite', 'cell--fraction', 'cell--pow', 'cell--sqrt', 'cell--nroot', 'cell--abs');

  if (!value) return;

  if (value.ch != null) {
    cellEl.textContent = value.ch;
    return;
  }

  if (isComposite(value)) {
    cellEl.classList.add('cell--composite', `cell--${value.type}`);
    cellEl.appendChild(buildCompositeDOM(value, activeSlot));
  }
}

function buildCompositeDOM(cell, activeSlot) {
  const root = document.createElement('span');
  root.className = `composite composite--${cell.type}`;

  const slot = (name, klass, content, tag = 'span') => {
    const el = document.createElement(tag);
    el.className = `composite__${klass}`;
    if (activeSlot === name) el.classList.add('composite__slot--active');
    el.textContent = content || ' ';
    el.dataset.slot = name;
    return el;
  };

  switch (cell.type) {
    case 'fraction': {
      const num = slot('num', 'num', cell.num);
      const bar = document.createElement('span');
      bar.className = 'composite__bar';
      const den = slot('den', 'den', cell.den);
      // Width is handled by the surrounding cell's grid-column span — the
      // digits stay full-size and the bar simply gets wider.
      root.append(num, bar, den);
      break;
    }
    case 'pow': {
      const base = slot('base', 'base', cell.base);
      const exp = slot('exp', 'exp', cell.exp, 'sup');
      root.append(base, exp);
      break;
    }
    case 'sqrt': {
      const sym = document.createElement('span');
      sym.className = 'composite__sqrt-sym';
      sym.textContent = '√';
      const rad = slot('radicand', 'radicand', cell.radicand);
      root.append(sym, rad);
      break;
    }
    case 'nroot': {
      // ⁿ√x — index sits as a small superscript LEFT of the radical sign,
      // tucked into the crook of the √. Same one-cell footprint as plain √.
      const idx = slot('index', 'nroot-index', cell.index, 'sup');
      const sym = document.createElement('span');
      sym.className = 'composite__sqrt-sym';
      sym.textContent = '√';
      const rad = slot('radicand', 'radicand', cell.radicand);
      root.append(idx, sym, rad);
      break;
    }
    case 'abs': {
      const left = document.createElement('span');
      left.className = 'composite__abs-bar';
      left.textContent = '|';
      const inner = slot('inner', 'abs-inner', cell.inner);
      const right = document.createElement('span');
      right.className = 'composite__abs-bar';
      right.textContent = '|';
      root.append(left, inner, right);
      break;
    }
  }

  return root;
}

// Long-press → drag a row of calculation to a different row in the same
// work block. Triggers only on cells that already have content (typing on
// a blank cell still feels instant). On drop, calls onMoveRow(from, to)
// and the editor handles the model change + re-render.
function attachRowDrag(gridEl, block, onMoveRow, onDragStarted) {
  const LONG_PRESS_MS = 350;
  // Larger tolerance than the block-drag handle: the kid's finger drifts
  // a bit on long-press and we don't want to cancel as a "tap".
  const MOVE_TOLERANCE_PX = 8;

  let pressState = null;

  gridEl.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    const cellEl = event.target.closest('.cell');
    if (!cellEl) return;
    const r = Number(cellEl.dataset.r);
    if (Number.isNaN(r)) return;
    if (!rowHasContent(block, r)) return;

    if (pressState && pressState.timer) clearTimeout(pressState.timer);
    const pointerId = event.pointerId;
    pressState = {
      pointerId,
      r,
      startX: event.clientX,
      startY: event.clientY,
      timer: setTimeout(() => fireLongPress(pointerId), LONG_PRESS_MS)
    };
  });

  function clearPress() {
    if (!pressState) return;
    if (pressState.timer) clearTimeout(pressState.timer);
    pressState = null;
  }

  gridEl.addEventListener('pointermove', (event) => {
    if (!pressState || event.pointerId !== pressState.pointerId) return;
    const dx = Math.abs(event.clientX - pressState.startX);
    const dy = Math.abs(event.clientY - pressState.startY);
    if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clearPress();
  });
  gridEl.addEventListener('pointerup', clearPress);
  gridEl.addEventListener('pointercancel', clearPress);

  function fireLongPress(pointerId) {
    if (!pressState || pressState.pointerId !== pointerId) return;
    const sourceRow = pressState.r;
    pressState = null;
    onDragStarted();
    startRowDrag(sourceRow, pointerId);
  }

  function startRowDrag(sourceRow, pointerId) {
    const sourceCells = gridEl.querySelectorAll(`.cell[data-r="${sourceRow}"]`);
    sourceCells.forEach((c) => c.classList.add('cell--row-dragging'));

    const cellSize =
      parseFloat(getComputedStyle(gridEl).getPropertyValue('--cell-size')) || 38;
    let lastTargetRow = sourceRow;
    paintDropTarget(gridEl, lastTargetRow);

    const onMove = (event) => {
      if (event.pointerId !== pointerId) return;
      const rect = gridEl.getBoundingClientRect();
      const yRel = event.clientY - rect.top;
      const newTarget = clampNumber(
        Math.floor(yRel / cellSize),
        0,
        block.rows - 1
      );
      if (newTarget !== lastTargetRow) {
        lastTargetRow = newTarget;
        paintDropTarget(gridEl, lastTargetRow);
      }
    };

    const onUp = (event) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      sourceCells.forEach((c) => c.classList.remove('cell--row-dragging'));
      clearDropTarget(gridEl);
      if (lastTargetRow !== sourceRow) {
        onMoveRow(sourceRow, lastTargetRow);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
}

function rowHasContent(block, row) {
  for (const key of Object.keys(block.cells)) {
    if (Number(key.split(',', 1)[0]) === row) return true;
  }
  return false;
}

function paintDropTarget(gridEl, row) {
  clearDropTarget(gridEl);
  gridEl
    .querySelectorAll(`.cell[data-r="${row}"]`)
    .forEach((c) => c.classList.add('cell--drop-target'));
}

function clearDropTarget(gridEl) {
  gridEl
    .querySelectorAll('.cell--drop-target')
    .forEach((c) => c.classList.remove('cell--drop-target'));
}

function clampNumber(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export { cellKey, compositeSlots };
