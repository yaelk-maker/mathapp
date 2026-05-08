// Page = ordered list of blocks rendered top-to-bottom.
// The grid only exists inside WorkBlocks, never on the page itself.
// This is the architectural guarantee that makes uploaded worksheets render
// cleanly with no grid bleed (the core fix vs. ModMath).

export const BLOCK = Object.freeze({
  WORK: 'work',
  WORKSHEET: 'worksheet'
});

export const DEFAULT_GRID = Object.freeze({ rows: 14, cols: 18 });

let _counter = 0;
function blockId() {
  _counter += 1;
  return `b_${Date.now().toString(36)}_${_counter}_${Math.random().toString(36).slice(2, 6)}`;
}

export function newWorkBlock({ rows = DEFAULT_GRID.rows, cols = DEFAULT_GRID.cols } = {}) {
  return {
    type: BLOCK.WORK,
    id: blockId(),
    rows,
    cols,
    // Sparse map of "r,c" -> { ch: <single character> }.
    // Composite cells (fractions, etc.) added in Phase 5 will use a richer shape.
    cells: {}
  };
}

export function newWorksheetBlock({ blobId, naturalWidth, naturalHeight }) {
  return {
    type: BLOCK.WORKSHEET,
    id: blockId(),
    blobId,
    naturalWidth: naturalWidth || 0,
    naturalHeight: naturalHeight || 0
  };
}

export function cellKey(row, col) {
  return `${row},${col}`;
}

export function getCell(block, row, col) {
  return block.cells[cellKey(row, col)];
}

export function setCell(block, row, col, value) {
  const key = cellKey(row, col);
  if (value == null || value.ch === '' || value.ch == null) {
    delete block.cells[key];
  } else {
    block.cells[key] = value;
  }
}
