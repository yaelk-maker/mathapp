// Renders a WorkBlock as a CSS-grid. Every cell is 1 logical position.
// Atoms hold one character. Composite cells (fractions, exponents, sqrt, abs)
// render with custom inner DOM but still occupy exactly one grid position.
// Math is LTR even when the page UI is RTL.

import { getCell, cellKey, isComposite, compositeSlots } from '../page-model.js';

export function renderWorkBlock(block, options = {}) {
  const { onCellTap, cursor } = options;

  const wrapper = document.createElement('div');
  wrapper.className = 'workblock';
  wrapper.setAttribute('dir', 'ltr');
  wrapper.dataset.blockId = block.id;

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.setProperty('--rows', block.rows);
  grid.style.setProperty('--cols', block.cols);

  for (let r = 0; r < block.rows; r += 1) {
    for (let c = 0; c < block.cols; c += 1) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;

      const value = getCell(block, r, c);
      const isCursor = cursor && cursor.r === r && cursor.c === c;
      paintCell(cell, value, isCursor ? cursor.slot : null);

      if (isCursor) cell.classList.add('cell--cursor');

      grid.appendChild(cell);
    }
  }

  if (onCellTap) {
    grid.addEventListener('click', (event) => {
      const target = event.target.closest('.cell');
      if (!target) return;
      const r = Number(target.dataset.r);
      const c = Number(target.dataset.c);
      onCellTap(r, c);
    });
  }

  wrapper.appendChild(grid);
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
  cellEl.classList.remove('cell--composite', 'cell--fraction', 'cell--pow', 'cell--sqrt', 'cell--abs');

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
      // Tighten font when slot strings get long.
      const longest = Math.max((cell.num || '').length, (cell.den || '').length);
      if (longest >= 2) root.classList.add('composite--tight');
      if (longest >= 3) root.classList.add('composite--very-tight');
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

export { cellKey, compositeSlots };
