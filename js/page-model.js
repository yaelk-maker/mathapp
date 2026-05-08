// Page = ordered list of blocks rendered top-to-bottom.
// The grid only exists inside WorkBlocks, never on the page itself.
// This is the architectural guarantee that makes uploaded worksheets render
// cleanly with no grid bleed (the core fix vs. ModMath).

export const BLOCK = Object.freeze({
  WORK: 'work',
  WORKSHEET: 'worksheet'
});

// Composite cell types — Phase 5. Each composite occupies one logical grid
// cell but renders with custom internal structure (a fraction stacks num/den,
// an exponent has a superscript, sqrt draws a radical sign + radicand, etc.).
// String slots hold the slot's contents; multi-character slots are allowed.
export const COMPOSITE = Object.freeze({
  FRACTION: 'fraction',
  POW: 'pow',
  SQRT: 'sqrt',
  ABS: 'abs'
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
  if (value == null) {
    delete block.cells[key];
    return;
  }
  // Atom with empty char: clear cell. Composites are kept even when empty
  // (they're "active" placeholders the cursor lives inside).
  if (value.ch === '' || (value.ch == null && !value.type)) {
    delete block.cells[key];
    return;
  }
  block.cells[key] = value;
}

export function isComposite(cell) {
  return cell != null && typeof cell.type === 'string';
}

// Slots in display order (top-to-bottom for vertical, left-to-right for inline).
export function compositeSlots(cell) {
  if (!isComposite(cell)) return [];
  switch (cell.type) {
    case COMPOSITE.FRACTION: return ['num', 'den'];
    case COMPOSITE.POW:      return ['base', 'exp'];
    case COMPOSITE.SQRT:     return ['radicand'];
    case COMPOSITE.ABS:      return ['inner'];
    default: return [];
  }
}

export function newFractionCell(num = '', den = '') {
  return { type: COMPOSITE.FRACTION, num, den };
}
export function newPowCell(base = '', exp = '') {
  return { type: COMPOSITE.POW, base, exp };
}
export function newSqrtCell(radicand = '') {
  return { type: COMPOSITE.SQRT, radicand };
}
export function newAbsCell(inner = '') {
  return { type: COMPOSITE.ABS, inner };
}

export function isCompositeEmpty(cell) {
  if (!isComposite(cell)) return false;
  return compositeSlots(cell).every((slot) => !cell[slot]);
}
