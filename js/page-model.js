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
  NROOT: 'nroot',
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
    // Index slot is entered FIRST so the kid types the n in ⁿ√ before the
    // radicand — pressing arrow-down (or right-after-typing) moves into the
    // radicand. See arrowVertical's nroot branch in editor.js.
    case COMPOSITE.NROOT:    return ['index', 'radicand'];
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
export function newNRootCell(index = '', radicand = '') {
  return { type: COMPOSITE.NROOT, index, radicand };
}
export function newAbsCell(inner = '') {
  return { type: COMPOSITE.ABS, inner };
}

export function isCompositeEmpty(cell) {
  if (!isComposite(cell)) return false;
  return compositeSlots(cell).every((slot) => !cell[slot]);
}

// How many grid columns a cell occupies. Fractions expand to fit their
// numerator and denominator; everything else is 1 cell wide.
//
// Each character in a fraction slot is rendered at ~0.6em with tight letter
// spacing — significantly narrower than a full grid cell. Reserving one cell
// per character made the fraction bar 2-3× wider than the digits, wasting
// horizontal space. We pack CHARS_PER_FRACTION_CELL chars per cell so the
// bar hugs the calculation. At 38px cells with a ~14px monospace fraction
// font (≈9-10px per char including letter-spacing), five chars fit per cell
// almost exactly — landing the bar right at the text edge while letting
// longer numerators/denominators (e.g. 12345) live in two cells instead of
// three, so the kid hits the grid edge less often.
const CHARS_PER_FRACTION_CELL = 5;
export function compositeWidth(cell) {
  if (!isComposite(cell)) return 1;
  if (cell.type === COMPOSITE.FRACTION) {
    const numLen = (cell.num || '').length;
    const denLen = (cell.den || '').length;
    const maxLen = Math.max(numLen, denLen);
    return Math.max(Math.ceil(maxLen / CHARS_PER_FRACTION_CELL), 1);
  }
  return 1;
}

// Set of "r,c" keys that are occupied by a multi-cell composite anchored at
// a different cell. Used by the grid renderer to skip the secondary cells.
export function occupiedCellSet(block) {
  const occupied = new Set();
  for (const [key, cell] of Object.entries(block.cells)) {
    const w = compositeWidth(cell);
    if (w <= 1) continue;
    const [r, c] = key.split(',').map(Number);
    for (let i = 1; i < w; i += 1) {
      occupied.add(`${r},${c + i}`);
    }
  }
  return occupied;
}

// If the given (r, c) is occupied by a multi-cell composite anchored elsewhere,
// returns that anchor's {r, c}. Otherwise returns null (or the cell IS the
// anchor / empty).
export function findOccupyingAnchor(block, r, c) {
  // If there's a direct cell at (r, c) it's its own anchor.
  if (block.cells[`${r},${c}`]) return null;
  // Walk back along the row looking for an anchor whose width covers (r, c).
  // Bound the search at MAX_WIDTH to avoid scanning the entire row.
  const MAX_WIDTH = 16;
  for (let cc = c - 1; cc >= Math.max(0, c - MAX_WIDTH); cc -= 1) {
    const cell = block.cells[`${r},${cc}`];
    if (!cell) continue;
    const w = compositeWidth(cell);
    if (cc + w > c) return { r, c: cc };
  }
  return null;
}
