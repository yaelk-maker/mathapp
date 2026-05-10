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
  findOccupyingAnchor,
  occupiedCellSet
} from '../page-model.js';

export function renderWorkBlock(block, options = {}) {
  const { onCellTap, cursor, onDelete, onMovePart } = options;

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

  // Columns containing a comparison/equality symbol — used to draw faint
  // vertical alignment guides so the kid can stack `>`/`<`/`=` across solving
  // steps without manually counting cells.
  const ALIGN_CHARS = new Set(['=', '>', '<', '≤', '≥', '≠']);
  const alignCols = new Set();

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

      if (value && !isComposite(value) && ALIGN_CHARS.has(value.ch)) {
        alignCols.add(c);
      }

      grid.appendChild(cell);
    }
  }

  // Render a faint vertical guide for each column where a comparison symbol
  // lives. Visual-only; click events fall through to the cells beneath via
  // pointer-events: none. The guide spans only as far down as the deepest
  // row with content (plus one row of headroom for the next step) — without
  // the trim, the dashed line ran through every empty row at the bottom of
  // the block and made the work area look full of grid lines.
  let maxContentRow = -1;
  for (const key of Object.keys(block.cells)) {
    const r = Number(key.split(',')[0]);
    if (r > maxContentRow) maxContentRow = r;
  }
  const guideRowSpan = Math.min(
    block.rows,
    maxContentRow >= 0 ? maxContentRow + 2 : 1
  );
  for (const col of alignCols) {
    const guide = document.createElement('div');
    guide.className = 'grid__align-guide';
    guide.style.gridRowStart = 1;
    guide.style.gridRowEnd = `span ${guideRowSpan}`;
    guide.style.gridColumnStart = col + 1;
    guide.style.gridColumnEnd = 'span 1';
    grid.appendChild(guide);
  }

  // Long-press on a non-empty cell starts a "move part" drag — the kid
  // grabs the contiguous run of cells the press lands on (one fraction,
  // one polynomial term, etc.) and drops it anywhere in the work block,
  // including sideways. Suppresses the cursor-positioning click that
  // would otherwise fire on pointerup.
  let suppressNextClick = false;
  if (onMovePart) attachPartDrag(grid, block, onMovePart, () => {
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

// Long-press a cell that's part of a calculation → popup menu with
// "← שמאלה" / "ימינה →" buttons. Each tap shifts the contiguous run of
// non-empty cells (the "part") that the press landed on by one column in
// that direction. The menu stays open so the kid can step the calculation
// across multiple columns without re-pressing; it dismisses on a tap
// outside the menu.
function attachPartDrag(gridEl, block, onMovePart, onDragStarted) {
  const LONG_PRESS_MS = 350;
  // Slightly larger tolerance than the block-drag handle: a long-press
  // finger drifts a bit and we don't want every wobble to cancel as a tap.
  const MOVE_TOLERANCE_PX = 8;

  let pressState = null;

  gridEl.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    const cellEl = event.target.closest('.cell');
    if (!cellEl) return;
    const r = Number(cellEl.dataset.r);
    const c = Number(cellEl.dataset.c);
    if (Number.isNaN(r) || Number.isNaN(c)) return;

    const part = findPartAt(block, r, c);
    if (!part) return;

    if (pressState && pressState.timer) clearTimeout(pressState.timer);
    const pointerId = event.pointerId;
    pressState = {
      pointerId,
      part,
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
    const part = pressState.part;
    const startX = pressState.startX;
    const startY = pressState.startY;
    pressState = null;
    // Tell the grid to swallow the click that pointerup will synthesise so
    // the long-press doesn't double as a cursor-positioning tap.
    onDragStarted();
    showMoveMenu(part, startX, startY);
  }

  function showMoveMenu(part, x, y) {
    // Tear down any leftover menu first — a fresh long-press always wins.
    document.querySelectorAll('.part-move-menu').forEach((el) => el.remove());

    const menu = document.createElement('div');
    menu.className = 'part-move-menu';
    menu.setAttribute('role', 'menu');

    // The part's columns shift as the kid taps move buttons; re-render
    // tears down `gridEl`'s DOM but the captured `block` reference is the
    // same object across renders, so canMovePart stays correct as long as
    // we keep livePart's coordinates in sync with each successful move.
    const livePart = { ...part };

    const tryMove = (dcol) => {
      if (canMovePart(block, livePart, 0, dcol)) {
        onMovePart(livePart, 0, dcol);
        livePart.startCol += dcol;
        livePart.endCol += dcol;
      } else {
        flashPartRefuse(gridEl, livePart);
      }
    };

    const makeBtn = (label, dcol) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'part-move-menu__btn';
      btn.textContent = label;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        tryMove(dcol);
      });
      return btn;
    };

    // "ימינה" advances the column index (math is LTR, so +1 is rightward).
    menu.append(makeBtn('← שמאלה', -1), makeBtn('ימינה →', +1));
    document.body.appendChild(menu);

    // Position above the press point. Fall back to below if the menu would
    // clip the top of the viewport, and clamp horizontally so the buttons
    // are always reachable on narrow screens.
    const rect = menu.getBoundingClientRect();
    const w = rect.width || 200;
    const h = rect.height || 44;
    let left = x - w / 2;
    let top = y - h - 14;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (top < 8) top = y + 18;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const dismiss = (e) => {
      if (menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener('pointerdown', dismiss, true);
    };
    // Defer one tick so the long-press's own pointerup doesn't dismiss us.
    setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
  }
}

// Find the contiguous run of non-empty cells in row `r` that contains
// column `c`. Returns { row, startCol, endCol } (inclusive) or null if
// (r, c) is empty. "Non-empty" means: an anchor lives at this cell OR
// this cell is covered by a wider composite anchored to the left.
function findPartAt(block, r, c) {
  const isOccupied = (col) => {
    if (block.cells[`${r},${col}`]) return true;
    if (findOccupyingAnchor(block, r, col)) return true;
    return false;
  };
  if (!isOccupied(c)) return null;
  let startCol = c;
  while (startCol > 0 && isOccupied(startCol - 1)) startCol -= 1;
  let endCol = c;
  while (endCol + 1 < block.cols && isOccupied(endCol + 1)) endCol += 1;
  return { row: r, startCol, endCol };
}

// Validate that moving the part by (drow, dcol) lands every anchor and
// every covered cell on a position that is either empty or already part
// of the source. Out-of-bounds is also a refusal.
function canMovePart(block, part, drow, dcol) {
  if (drow === 0 && dcol === 0) return false;
  const sourceKeys = new Set();
  const moves = [];
  for (let c = part.startCol; c <= part.endCol; c += 1) {
    const cell = block.cells[`${part.row},${c}`];
    if (!cell) continue;
    const w = compositeWidth(cell);
    moves.push({ oldR: part.row, oldC: c, newR: part.row + drow, newC: c + dcol, w });
    for (let i = 0; i < w; i += 1) sourceKeys.add(`${part.row},${c + i}`);
  }
  for (const m of moves) {
    if (m.newR < 0 || m.newR >= block.rows) return false;
    if (m.newC < 0 || m.newC + m.w > block.cols) return false;
    for (let i = 0; i < m.w; i += 1) {
      const k = `${m.newR},${m.newC + i}`;
      if (sourceKeys.has(k)) continue;
      if (block.cells[k]) return false;
      const overlap = findOccupyingAnchor(block, m.newR, m.newC + i);
      if (overlap && !sourceKeys.has(`${overlap.r},${overlap.c}`)) return false;
    }
  }
  return true;
}

function flashPartRefuse(gridEl, part) {
  for (let c = part.startCol; c <= part.endCol; c += 1) {
    const el = gridEl.querySelector(`.cell[data-r="${part.row}"][data-c="${c}"]`);
    if (!el) continue;
    el.classList.add('cell--refuse');
    setTimeout(() => el.classList.remove('cell--refuse'), 260);
  }
}

export { cellKey, compositeSlots };
