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

// 25 cols × 4 rows. Cols: 25 leaves 23 writable columns (after the
// MARGIN_COLS margin), enough for the README's headline distribution
// line — 6x−3(2x−3)>(x+4)−4(x−1), 23 atoms. Rows: 4 is the per-exercise
// default — each exercise now lives in its own block (see Exercise
// labels below), and 4 rows is enough to lay out a typical solving
// step without leaving a huge blank tail under the work. The kid can
// still add rows via the toolbar's ➕↕ button or the corner ⤡ handle.
// Notebooks created before this change still load at their stored
// size; migrateWorkBlockSize only shrinks (never grows), and only when
// the existing content already fits — so a kid with content past row 4
// keeps their tall block.
export const DEFAULT_GRID = Object.freeze({ rows: 4, cols: 25 });

// Reserved "notebook margin" on the left of every work block. The first
// MARGIN_COLS columns render with the same grid lines as the rest of the
// work area but the kid can't tap them or move the cursor into them — the
// effect is a paper-style left margin without sacrificing horizontal
// resolution (the grid is still drawn end-to-end, only the cursor is
// restricted). Apple-Pencil drawing still works across the margin since
// the canvas overlay is independent of grid cells. The cursor starts at
// column MARGIN_COLS in every new work block.
export const MARGIN_COLS = 2;

let _counter = 0;
function blockId() {
  _counter += 1;
  return `b_${Date.now().toString(36)}_${_counter}_${Math.random().toString(36).slice(2, 6)}`;
}

export function newWorkBlock({
  rows = DEFAULT_GRID.rows,
  cols = DEFAULT_GRID.cols,
  label = '1'
} = {}) {
  return {
    type: BLOCK.WORK,
    id: blockId(),
    rows,
    cols,
    // Exercise label rendered as "תרגיל <label>" above the grid. Editable
    // by the kid (tap to focus, in-app keypad inserts) and auto-incremented
    // by the editor when "+ תרגיל חדש" creates the next block. Empty string
    // is allowed — the kid types it in fresh, or it's the result of
    // nextExerciseLabel failing to recognise the previous label's pattern.
    label,
    // Sparse map of "r,c" -> { ch: <single character> }.
    // Composite cells (fractions, etc.) added in Phase 5 will use a richer shape.
    cells: {}
  };
}

// Hebrew gematria letters in sequence — used to auto-increment exercise
// labels like ה → ו, ה׳ → ו׳. Final forms (ך ם ן ף ץ) collapse to their
// base letter before lookup so כ → ל still works even if the kid happens
// to type a final form.
const HEBREW_LETTERS = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','כ','ל','מ','נ','ס','ע','פ','צ','ק','ר','ש','ת'];
const HEBREW_FINAL_TO_BASE = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Given the previous exercise block's label, compute the next one. The
// kid sets the first label on a page (e.g. "8" or "ה׳"); subsequent
// "+ תרגיל חדש" presses auto-increment from there. Returns the new
// label string, or '' when the previous label doesn't match a pattern
// we know how to advance — the editor then leaves the chip empty for
// the kid to fill in by hand rather than guessing wrong.
//
// Patterns handled:
//   "8"   → "9"     (any non-negative integer)
//   "ה"   → "ו"     (single Hebrew letter)
//   "ה׳"  → "ו׳"    (Hebrew letter + geresh — geresh is preserved verbatim)
//   "ה."  → "ו."    (any non-letter trailing chars are preserved)
// Anything else (compound labels like "תרגיל 8", letter pairs like "יא",
// past ת with no successor) returns '' so the kid sees an empty chip
// and types the label themselves.
export function nextExerciseLabel(prev) {
  if (!prev) return '';
  const trimmed = String(prev).trim();
  if (!trimmed) return '';
  if (/^\d+$/.test(trimmed)) {
    return String(parseInt(trimmed, 10) + 1);
  }
  const m = trimmed.match(/^([א-ת])(.*)$/);
  if (m) {
    const letter = m[1];
    const suffix = m[2];
    const base = HEBREW_FINAL_TO_BASE[letter] || letter;
    const idx = HEBREW_LETTERS.indexOf(base);
    if (idx >= 0 && idx + 1 < HEBREW_LETTERS.length) {
      return HEBREW_LETTERS[idx + 1] + suffix;
    }
  }
  return '';
}

export function newWorksheetBlock({ blobId, naturalWidth, naturalHeight }) {
  return {
    type: BLOCK.WORKSHEET,
    id: blockId(),
    blobId,
    naturalWidth: naturalWidth || 0,
    naturalHeight: naturalHeight || 0,
    annotations: []
  };
}

// Typed-text annotations that float on top of a worksheet image. Position and
// width are stored as fractions of the rendered overlay (0..1) so they stay
// anchored at any zoom / display size. fontSize is in `cqh` units — 1cqh is
// 1% of the overlay's height — so text scales with the image the same way a
// printed worksheet's body text would.
export const DEFAULT_ANNOTATION_FONT_CQH = 2.5;
export const ANNOTATION_FONT_MIN_CQH = 1.2;
export const ANNOTATION_FONT_MAX_CQH = 8.0;
export const ANNOTATION_FONT_STEP_CQH = 0.4;

let _annotCounter = 0;
function annotationId() {
  _annotCounter += 1;
  return `a_${Date.now().toString(36)}_${_annotCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

export function newAnnotation({
  x = 0.5,
  y = 0.5,
  w = 0.25,
  fontSize = DEFAULT_ANNOTATION_FONT_CQH,
  text = ''
} = {}) {
  return { id: annotationId(), x, y, w, fontSize, text };
}

// Grid annotation: a small work-grid that floats on a worksheet image so
// the kid can do a calculation with the same cell alignment as the main
// work area (one digit per cell). Storage shape mirrors a WorkBlock's
// cells/rows/cols, but the annotation lives inside a worksheet block
// rather than at the page level. The defaults are tuned for a short
// scratch calculation under a typical worksheet exercise — wider than
// a fraction needs but small enough to drop next to the printed
// question without covering the worksheet text.
export const GRID_ANNOTATION_DEFAULT = Object.freeze({ rows: 3, cols: 8 });
export const GRID_ANNOTATION_MIN = Object.freeze({ rows: 1, cols: 2 });
export const GRID_ANNOTATION_MAX = Object.freeze({ rows: 12, cols: 20 });

export function newGridAnnotation({
  x = 0.5,
  y = 0.5,
  w = 0.30,
  rows = GRID_ANNOTATION_DEFAULT.rows,
  cols = GRID_ANNOTATION_DEFAULT.cols
} = {}) {
  return {
    id: annotationId(),
    type: 'grid',
    x, y, w,
    rows,
    cols,
    cells: {}
  };
}

export function isGridAnnotation(annot) {
  return !!(annot && annot.type === 'grid');
}

export function getAnnotations(block) {
  if (!block || !Array.isArray(block.annotations)) return [];
  return block.annotations;
}

export function clampAnnotationFont(size) {
  if (!Number.isFinite(size)) return DEFAULT_ANNOTATION_FONT_CQH;
  return Math.min(ANNOTATION_FONT_MAX_CQH, Math.max(ANNOTATION_FONT_MIN_CQH, size));
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
// bar hugs the calculation. 4 chars/cell is calibrated for the portrait-iPad
// ~28-30px cells now in use after the bigger-cells change: at 28px cells
// with ~0.6em font and 0.08em letter-spacing, four chars fit per cell almost
// exactly. The previous value (5) was tuned for 38px cells and let a 13-char
// denominator like "(5×x)−2×(5−1)" overflow the spanned cells on portrait.
const CHARS_PER_FRACTION_CELL = 4;
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

// One-shot migration: shifts every cell of a work block out of the reserved
// notebook margin (cols 0..MARGIN_COLS-1). Returns true when the block was
// modified, false when no cells lived in the margin. Used by the editor at
// page load so notebooks that pre-date the margin feature get their stuck
// content moved into the writable area rather than left sitting under the
// red margin line, where it can't be tapped or edited. The block's cols
// count grows (capped at 40) if shifting would otherwise push content past
// the existing right edge.
export function migrateWorkBlockMargin(block) {
  let needsShift = false;
  for (const k of Object.keys(block.cells)) {
    const c = Number(k.split(',')[1]);
    if (c < MARGIN_COLS) { needsShift = true; break; }
  }
  if (!needsShift) return false;

  let maxColAfter = -1;
  for (const [k, cell] of Object.entries(block.cells)) {
    const c = Number(k.split(',')[1]);
    const w = compositeWidth(cell);
    const after = c + MARGIN_COLS + w - 1;
    if (after > maxColAfter) maxColAfter = after;
  }
  const requiredCols = maxColAfter + 1;
  if (requiredCols > block.cols) {
    block.cols = Math.min(40, requiredCols);
  }

  const newCells = {};
  for (const [k, cell] of Object.entries(block.cells)) {
    const [r, c] = k.split(',').map(Number);
    const newC = c + MARGIN_COLS;
    // Drop anything that would still land past the (possibly-grown) right
    // edge — at the 40-col cap this is the only failure mode and it only
    // affects truly extreme notebooks.
    if (newC < block.cols) {
      newCells[`${r},${newC}`] = cell;
    }
  }
  block.cells = newCells;
  return true;
}

// Shrink a work block toward DEFAULT_GRID dimensions if doing so doesn't
// truncate existing content. Used at page load so notebooks created with
// the old 30×24 defaults pick up the new 25×19 sizing (which lets each
// cell render bigger). If the kid had explicitly resized a block, or has
// content past the new defaults, the block is left at its current size.
export function migrateWorkBlockSize(block) {
  let maxRow = -1;
  let maxCol = -1;
  for (const [k, cell] of Object.entries(block.cells)) {
    const [r, c] = k.split(',').map(Number);
    if (r > maxRow) maxRow = r;
    const w = compositeWidth(cell);
    if (c + w - 1 > maxCol) maxCol = c + w - 1;
  }
  let modified = false;
  if (block.rows > DEFAULT_GRID.rows && maxRow < DEFAULT_GRID.rows) {
    block.rows = DEFAULT_GRID.rows;
    modified = true;
  }
  if (block.cols > DEFAULT_GRID.cols && maxCol < DEFAULT_GRID.cols) {
    block.cols = DEFAULT_GRID.cols;
    modified = true;
  }
  return modified;
}
