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
  occupiedCellSet,
  MARGIN_COLS
} from '../page-model.js';

export function renderWorkBlock(block, options = {}) {
  const { onCellTap, cursor, onDelete, onMovePart, onLabelEdit } = options;

  const wrapper = document.createElement('div');
  wrapper.className = 'workblock';
  wrapper.setAttribute('dir', 'ltr');
  wrapper.dataset.blockId = block.id;

  // Exercise header — "תרגיל <label>" rendered above the grid. The label
  // is contenteditable so the kid can tap it and override (e.g. when the
  // worksheet starts at 8 or uses Hebrew letters). The prefix "תרגיל" is
  // a static label rendered around it, so only the identifier is editable.
  // dir="rtl" so the static "תרגיל" reads right-to-left even though the
  // grid wrapper above is dir="ltr" for math flow.
  const header = document.createElement('header');
  header.className = 'workblock__header';
  header.setAttribute('dir', 'rtl');
  const prefix = document.createElement('span');
  prefix.className = 'workblock__exercise-prefix';
  prefix.textContent = 'תרגיל';
  const labelEl = document.createElement('span');
  labelEl.className = 'workblock__exercise-label';
  labelEl.setAttribute('contenteditable', 'plaintext-only');
  labelEl.setAttribute('inputmode', 'none');
  labelEl.setAttribute('spellcheck', 'false');
  labelEl.setAttribute('dir', 'auto');
  labelEl.setAttribute('aria-label', 'מספר תרגיל');
  labelEl.dataset.blockId = block.id;
  labelEl.textContent = block.label || '';
  if (onLabelEdit) {
    labelEl.addEventListener('input', () => onLabelEdit(block.id, labelEl.textContent));
    // Stop the tap from bubbling to the grid (which would steal focus
    // and move the workblock cursor) and from the workblock wrapper's
    // drag-handle pointerdown listener.
    labelEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    labelEl.addEventListener('mousedown', (e) => e.stopPropagation());
    // Select-all-on-focus so the next keypress replaces the existing
    // label instead of appending to it. Without this a kid tapping the
    // chip showing "1" and pressing "8" would see "18", not "8".
    // requestAnimationFrame waits one tick so the browser's own caret
    // placement (from the focusing tap) doesn't immediately clobber
    // our selection.
    labelEl.addEventListener('focus', () => {
      requestAnimationFrame(() => {
        if (document.activeElement !== labelEl) return;
        const range = document.createRange();
        range.selectNodeContents(labelEl);
        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });
  }
  header.append(prefix, labelEl);
  wrapper.appendChild(header);

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
      // Cells in the reserved left margin paint the same grid lines but are
      // not interactive — see MARGIN_COLS in page-model.js. The class drives
      // both the notebook-style background and a bolder right border on the
      // last margin column.
      if (c < MARGIN_COLS) cell.classList.add('cell--margin');

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
      // Reserved-margin cells silently swallow taps. Without this the
      // cursor would land in c=0/1 and the kid would lose her place.
      if (c < MARGIN_COLS) return;
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
    del.title = 'לחצי וחזיקי כדי להסיר אזור פתרון';
    del.setAttribute('aria-label', 'הסר אזור פתרון (לחיצה ארוכה)');
    del.addEventListener('mousedown', (e) => e.preventDefault());
    // Long-press gate. Unlike notebook/folder delete (a deliberate UI
    // affordance the kid taps on purpose), this × sits ON TOP of the
    // worksheet/grid area where the kid is typing and drawing — a
    // tremor or accidental palm contact would otherwise sail straight
    // into the confirm dialog. 700ms hold + visual fill matches the
    // home-screen pattern the kid is already trained on.
    wireWorkblockDeleteLongPress(del, () => onDelete(block.id));
    wrapper.appendChild(del);
  }

  return { wrapper, grid };
}

// 700ms press-and-hold before the confirm dialog fires. Matches the home-
// screen notebook-delete cadence the kid is already trained on. Adds a
// CSS class during the hold so the .longpress-fill span can animate a
// progress arc into place.
const WORKBLOCK_DELETE_LONGPRESS_MS = 700;
function wireWorkblockDeleteLongPress(btn, onFire) {
  let timer = null;
  let triggered = false;
  // Inject the longpress-fill span so the CSS arming animation has
  // somewhere to paint into — same shape as the home-screen buttons.
  if (!btn.querySelector('.longpress-fill')) {
    const fill = document.createElement('span');
    fill.className = 'longpress-fill';
    btn.insertBefore(fill, btn.firstChild);
  }
  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    btn.classList.remove('workblock__delete--arming');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    triggered = false;
    btn.classList.add('workblock__delete--arming');
    timer = setTimeout(() => {
      triggered = true;
      btn.classList.remove('workblock__delete--arming');
      onFire();
    }, WORKBLOCK_DELETE_LONGPRESS_MS);
  });
  btn.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    cancel();
  });
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('pointercancel', cancel);
  // Suppress the synthetic click so a brush-by tap never reaches the
  // confirm dialog (only the timer-fired path does).
  btn.addEventListener('click', (e) => e.stopPropagation());
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

// Long-press a cell that's part of a calculation → enter selection mode.
// Initial selection is just the long-pressed cell; the kid can drag along
// the row (while still pressing) to extend the selection cell-by-cell. On
// release a popup appears with four buttons:
//   ← הרחב  ← זוז   זוז →   הרחב →
// "הרחב" extends the selection by one column on that side, "זוז" shifts the
// whole selection by one column. The selection stays highlighted while the
// menu is open so the kid sees what they're moving. The menu dismisses on
// a tap outside it.
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

    // Only start a long-press on a cell that holds something — empty cells
    // can't be moved, and starting a selection there would be confusing.
    if (!block.cells[`${r},${c}`] && !findOccupyingAnchor(block, r, c)) return;

    if (pressState && pressState.timer) clearTimeout(pressState.timer);
    const pointerId = event.pointerId;
    pressState = {
      pointerId,
      startR: r,
      startC: c,
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

  // After the kid moves the part, the workblock re-renders and our captured
  // `gridEl` is detached. Look up the live grid by the block id (the
  // workblock wrapper carries it as data-block-id) so subsequent paints and
  // refusal flashes land on the in-DOM cells.
  function liveGrid() {
    const w = document.querySelector(`.workblock[data-block-id="${block.id}"]`);
    return (w && w.querySelector('.grid')) || gridEl;
  }

  function paintSelection(sel) {
    const g = liveGrid();
    g.querySelectorAll('.cell--part-selecting').forEach((el) =>
      el.classList.remove('cell--part-selecting')
    );
    if (!sel) return;
    for (let cc = sel.startCol; cc <= sel.endCol; cc += 1) {
      const el = g.querySelector(`.cell[data-r="${sel.row}"][data-c="${cc}"]`);
      if (el) el.classList.add('cell--part-selecting');
    }
  }

  function fireLongPress(pointerId) {
    if (!pressState || pressState.pointerId !== pointerId) return;
    const startR = pressState.startR;
    const startC = pressState.startC;
    const startX = pressState.startX;
    const startY = pressState.startY;
    pressState = null;
    // Tell the grid to swallow the click that pointerup will synthesise so
    // the long-press doesn't double as a cursor-positioning tap.
    onDragStarted();

    const sel = { row: startR, anchorCol: startC, startCol: startC, endCol: startC };
    paintSelection(sel);

    const onMove = (e) => {
      if (e.pointerId !== pointerId) return;
      // elementFromPoint also works during pointer capture and across cells
      // — we don't get pointerover events on individual cells once the
      // browser implicit-captures the pointer to the original target.
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const cellEl = target && target.closest && target.closest('.cell');
      if (!cellEl) return;
      if (cellEl.closest('.grid') !== gridEl) return;
      const r = Number(cellEl.dataset.r);
      const c = Number(cellEl.dataset.c);
      if (r !== sel.row || Number.isNaN(c)) return;
      sel.startCol = Math.min(sel.anchorCol, c);
      sel.endCol = Math.max(sel.anchorCol, c);
      paintSelection(sel);
    };

    const onUp = (e) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      showMoveMenu(
        { row: sel.row, startCol: sel.startCol, endCol: sel.endCol },
        e.clientX || startX,
        e.clientY || startY
      );
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function showMoveMenu(part, x, y) {
    // Tear down any leftover menu first — a fresh long-press always wins.
    document.querySelectorAll('.part-move-menu').forEach((el) => el.remove());

    const menu = document.createElement('div');
    menu.className = 'part-move-menu';
    menu.setAttribute('role', 'menu');
    // Force LTR ordering so left-arrow buttons sit on the left of the menu
    // even though the surrounding page is RTL.
    menu.dir = 'ltr';

    // The selection's columns shift as the kid taps move buttons; re-render
    // tears down `gridEl`'s DOM but the captured `block` reference is the
    // same object across renders, so canMovePart stays correct as long as
    // we keep livePart's coordinates in sync with each successful move.
    const livePart = { ...part };
    paintSelection(livePart);

    const flashRefuse = () => {
      const g = liveGrid();
      for (let c = livePart.startCol; c <= livePart.endCol; c += 1) {
        const el = g.querySelector(`.cell[data-r="${livePart.row}"][data-c="${c}"]`);
        if (!el) continue;
        el.classList.add('cell--refuse');
        setTimeout(() => el.classList.remove('cell--refuse'), 260);
      }
    };

    const tryMove = (dcol) => {
      if (canMovePart(block, livePart, 0, dcol)) {
        onMovePart(livePart, 0, dcol);
        livePart.startCol += dcol;
        livePart.endCol += dcol;
        // Re-paint after the re-render settles. The await chain lives in
        // onMovePart; querying right away usually finds the new grid since
        // movePartAndSave's mutations are synchronous before the await.
        Promise.resolve().then(() => paintSelection(livePart));
      } else {
        flashRefuse();
      }
    };

    const tryExtend = (dir) => {
      if (dir < 0 && livePart.startCol > 0) {
        livePart.startCol -= 1;
      } else if (dir > 0 && livePart.endCol + 1 < block.cols) {
        livePart.endCol += 1;
      } else {
        flashRefuse();
        return;
      }
      paintSelection(livePart);
    };

    const makeBtn = (label, kind, dir) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `part-move-menu__btn part-move-menu__btn--${kind}`;
      btn.textContent = label;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (kind === 'extend') tryExtend(dir);
        else tryMove(dir);
      });
      return btn;
    };

    // LTR layout: left-arrow buttons on the LEFT, right-arrow on the RIGHT.
    menu.append(
      makeBtn('← הרחב', 'extend', -1),
      makeBtn('← זוז', 'move', -1),
      makeBtn('זוז →', 'move', +1),
      makeBtn('הרחב →', 'extend', +1)
    );
    document.body.appendChild(menu);

    // Position above the press point. Fall back to below if the menu would
    // clip the top of the viewport, and clamp horizontally so the buttons
    // are always reachable on narrow screens.
    const rect = menu.getBoundingClientRect();
    const w = rect.width || 280;
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
      paintSelection(null);
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
    // The first MARGIN_COLS are the reserved notebook margin — refuse any
    // move that would land content there, same as crossing the right/top
    // edge of the grid.
    if (m.newC < MARGIN_COLS || m.newC + m.w > block.cols) return false;
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
