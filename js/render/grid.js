// Renders a WorkBlock as a CSS-grid. Every cell is 1 character, gridlines
// always visible. Math is LTR even when the page UI is RTL.

import { getCell, cellKey } from '../page-model.js';

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
      if (value && value.ch) cell.textContent = value.ch;

      if (cursor && cursor.r === r && cursor.c === c) {
        cell.classList.add('cell--cursor');
      }

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

// Targeted updates to avoid re-rendering the whole grid on every keystroke.

export function updateCell(grid, block, r, c) {
  const cell = grid.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
  if (!cell) return;
  const value = getCell(block, r, c);
  cell.textContent = value && value.ch ? value.ch : '';
}

export function updateCursor(grid, prevCursor, nextCursor) {
  if (prevCursor) {
    const prev = grid.querySelector(
      `.cell[data-r="${prevCursor.r}"][data-c="${prevCursor.c}"]`
    );
    if (prev) prev.classList.remove('cell--cursor');
  }
  if (nextCursor) {
    const next = grid.querySelector(
      `.cell[data-r="${nextCursor.r}"][data-c="${nextCursor.c}"]`
    );
    if (next) next.classList.add('cell--cursor');
  }
}

// For debugging / future use
export { cellKey };
