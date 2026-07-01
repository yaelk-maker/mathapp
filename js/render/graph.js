// Renders a coordinate-plane graph as inline SVG.
//
// Two consumers share the same interactive plane (`buildGraphPlane`):
//   - a standalone GRAPH block (`renderGraphBlock`), and
//   - a graph annotation floating on a worksheet image (worksheet.js calls
//     buildGraphPlane and wraps it in the annotation drag/resize chrome).
// The "model" passed to buildGraphPlane is any object carrying
// view/tickStep/snapStep/points/lines + an id (a GRAPH block or a graph
// annotation both qualify).
//
// Math convention: +x to the right, +y up. The plane is dir="ltr" even on an
// RTL page (like the workblock grid). SVG (not Canvas) keeps axes crisp at any
// size, hit-tests taps in math space via one getScreenCTM() inverse, and prints
// vector-sharp. The page-spanning pencil canvas sits ABOVE every block, so when
// pen mode is on the canvas captures pointers and the plane is inert.

import { graphPointId, newGraphLine } from '../page-model.js';
import { isGraphAdvancedToolsEnabled } from '../settings.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MINUS = '−'; // proper minus sign for equation labels

// viewBox pixels per one math unit. The SVG scales to its container via
// width:100%, so this only sets internal resolution, not on-screen size.
const UNIT = 28;
// Padding (viewBox units) around the plane so axis arrowheads and the
// outermost tick labels aren't clipped at the SVG edge.
const PAD = 24;
// How close (in math units) a tap must land to an existing point to grab it
// instead of dropping a new one. Doubles as duplicate-prevention: a tap that
// snaps onto an existing point's coordinates is always within this radius.
const HIT_RADIUS = 0.6;
// How close (math units) a tap must land to a line to select it.
const LINE_HIT = 0.4;
// y=mx+b stepper increment and clamp range.
const FN_STEP = 0.5;
const FN_MIN = -10;
const FN_MAX = 10;

// MAËLYS-leaning neutrals for the static plane; the app's accent blue for the
// interactive points so they read as "the thing you place", consistent with
// every other tappable element in the app.
const COLOR_GRID = '#EBE5E2';
const COLOR_AXIS = '#120D0E';
const COLOR_LABEL = '#5A524D';
const COLOR_POINT = '#0b6cf2';
const COLOR_POINT_SEL = '#0958c4';
const COLOR_PREVIEW = '#968E89';
// Categorical line series (MAËLYS strong tones) assigned by line index.
const LINE_COLORS = ['#DB6B8A', '#736458', '#0b6cf2', '#5A524D'];

export function snap(value, step) {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Map a math coordinate to a viewBox pixel coordinate. yMax maps to the top
// (small py) because SVG y grows downward.
export function mathToPx(view, x, y) {
  return {
    px: PAD + (x - view.xMin) * UNIT,
    py: PAD + (view.yMax - y) * UNIT
  };
}

// Inverse of mathToPx — a viewBox pixel back to a math coordinate.
export function pxToMath(view, px, py) {
  return {
    x: (px - PAD) / UNIT + view.xMin,
    y: view.yMax - (py - PAD) / UNIT
  };
}

// Slope/intercept of the line through two distinct points; flags verticals
// (which y=mx+b can't represent).
export function lineFromTwoPoints(p1, p2) {
  if (p1.x === p2.x) return { vertical: true, x: p1.x };
  const m = (p2.y - p1.y) / (p2.x - p1.x);
  const b = p1.y - m * p1.x;
  return { vertical: false, m, b };
}

// Liang–Barsky clip of the INFINITE line through p1,p2 to the view rectangle.
// Returns the two boundary endpoints { a, b } in math space, or null if the
// line misses the view. dx=0 (vertical) is handled naturally by the p[i]===0
// "parallel" branches.
export function clipLineToView(view, p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (dx === 0 && dy === 0) return null;
  let t0 = -Infinity;
  let t1 = Infinity;
  const p = [-dx, dx, -dy, dy];
  const q = [p1.x - view.xMin, view.xMax - p1.x, p1.y - view.yMin, view.yMax - p1.y];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return null; // parallel to this edge and outside it
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return {
    a: { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
    b: { x: p1.x + t1 * dx, y: p1.y + t1 * dy }
  };
}

// Format a math value for a label / read-out, trimming a trailing ".0" so
// integers read as "3" not "3.0" while a half-step still shows "2.5".
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
// Same, but with a proper minus glyph for display contexts.
function fmtDisp(n) {
  return fmt(n).replace('-', MINUS);
}

// Build the "y = …" string for a line. Handles vertical (x = c), horizontal
// (y = c), unit slopes (x, −x) and sign-aware intercepts.
export function formatEquation(line) {
  let m;
  let b;
  if (line.kind === 'mxb') {
    m = line.m;
    b = line.b;
  } else {
    const d = lineFromTwoPoints(line.p1, line.p2);
    if (d.vertical) return `x = ${fmtDisp(d.x)}`;
    m = d.m;
    b = d.b;
  }
  if (m === 0) return `y = ${fmtDisp(b)}`;
  const coef = m === 1 ? 'x' : m === -1 ? `${MINUS}x` : `${fmtDisp(m)}x`;
  if (b > 0) return `y = ${coef} + ${fmt(b)}`;
  if (b < 0) return `y = ${coef} ${MINUS} ${fmt(Math.abs(b))}`;
  return `y = ${coef}`;
}

// Distance (math units) from point P to segment AB.
function distToSegment(P, A, B) {
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((P.x - A.x) * vx + (P.y - A.y) * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(P.x - (A.x + t * vx), P.y - (A.y + t * vy));
}

// Distance (math units) from P to the INFINITE line through A,B.
function distToLine(P, A, B) {
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const len = Math.hypot(vx, vy);
  if (!len) return Math.hypot(P.x - A.x, P.y - A.y);
  return Math.abs((P.x - A.x) * vy - (P.y - A.y) * vx) / len;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// The two math endpoints of a 'line'/'mxb' line (before view-clipping).
function lineEndpoints(view, ln) {
  if (ln.kind === 'mxb') {
    return [
      { x: view.xMin, y: ln.m * view.xMin + ln.b },
      { x: view.xMax, y: ln.m * view.xMax + ln.b }
    ];
  }
  return [ln.p1, ln.p2];
}

// Builds the interactive coordinate plane (tools + read-out + y=mx+b panel +
// SVG plot) for `model` and returns the wrapper element. Shared by the GRAPH
// block and the worksheet graph annotation.
export function buildGraphPlane(model, options = {}) {
  const {
    onEditStart = () => {},   // pushUndo — once per gesture before the first mutation
    onChange = () => {}       // queueSave — after data actually changes
  } = options;

  const view = model.view;
  const snapStep = model.snapStep > 0 ? model.snapStep : 1;
  const tickStep = model.tickStep > 0 ? model.tickStep : 1;
  if (!Array.isArray(model.points)) model.points = [];
  if (!Array.isArray(model.lines)) model.lines = [];
  // Coordinate labels — "(x, y)" text the kid places on the plane and fills
  // in himself (the classic "write the coordinates of the point" exercise).
  // Each is { id, x, y, vx, vy }: (x, y) anchors the label on the plane,
  // (vx, vy) are the VALUES he entered — deliberately independent of the
  // anchor, so a wrong answer stays his answer and the label can sit
  // beside a point without covering it.
  if (!Array.isArray(model.labels)) model.labels = [];

  const vbW = (view.xMax - view.xMin) * UNIT + PAD * 2;
  const vbH = (view.yMax - view.yMin) * UNIT + PAD * 2;

  const plane = document.createElement('div');
  plane.className = 'graphplane';

  // ---- bar: tool toggles + live read-out + clear ----
  const bar = document.createElement('div');
  bar.className = 'graphplane__bar';
  bar.setAttribute('dir', 'rtl');

  const tools = document.createElement('div');
  tools.className = 'graphblock__tools';
  const mkTool = (label, value, titleText) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graphblock__tool';
    btn.textContent = label;
    btn.dataset.tool = value;
    btn.title = titleText;
    return btn;
  };
  // Line (קו) and function (y=mx+b) are gated behind the home-screen setting
  // "כלי קו ופונקציה בגרף" — off by default. When disabled the kid only sees
  // נקודה / קטע; existing lines still render and can be tapped to delete, but
  // no new line/function can be created. Order preserved (point, line,
  // segment, fn) when both are shown.
  const advancedTools = isGraphAdvancedToolsEnabled();
  const tPoint = mkTool('נקודה', 'point', 'הקש על הרשת להוספת נקודה');
  const tSeg = mkTool('קטע', 'segment', 'הקש על שתי נקודות ליצירת קטע');
  const tLine = advancedTools ? mkTool('קו', 'line', 'הקש על שתי נקודות ליצירת קו ישר') : null;
  const tFn = advancedTools ? mkTool('y=mx+b', 'fn', 'הוספת פונקציה לפי שיפוע וחיתוך') : null;
  // Coordinate-label tool — not gated behind the advanced setting; writing
  // "(x, y)" next to a point is core plotting practice, same tier as נקודה.
  const tCoord = mkTool('(x,y)', 'coord', 'תווית שיעורים — הקש על הרשת במקום שבו תרצה את התווית ומלא את השיעורים');
  tools.append(tPoint);
  if (tLine) tools.append(tLine);
  tools.append(tSeg);
  tools.append(tCoord);
  if (tFn) tools.append(tFn);

  const readout = document.createElement('span');
  readout.className = 'graphblock__readout';
  readout.setAttribute('dir', 'ltr');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'graphblock__clear';
  clearBtn.textContent = 'נקה';
  clearBtn.title = 'מחיקת הכול';
  clearBtn.setAttribute('aria-label', 'מחיקת כל הנקודות והקווים');

  bar.append(tools, readout, clearBtn);

  // ---- y=mx+b panel ----
  const fnPanel = document.createElement('div');
  fnPanel.className = 'graphblock__fn';
  fnPanel.setAttribute('dir', 'ltr');
  fnPanel.hidden = true;

  // ---- coordinate-label panel ----
  // Reuses the fn-panel class so it inherits the stepper styling AND the
  // print-CSS hide (interaction chrome must never print).
  const coordPanel = document.createElement('div');
  coordPanel.className = 'graphblock__fn graphblock__coord';
  coordPanel.setAttribute('dir', 'ltr');
  coordPanel.hidden = true;

  // ---- plot ----
  const plot = document.createElement('div');
  plot.className = 'graphblock__plot';
  plot.style.aspectRatio = `${vbW} / ${vbH}`;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${vbW} ${vbH}`,
    class: 'graphblock__svg',
    role: 'img',
    'aria-label': 'מערכת צירים'
  });

  // Arrowhead marker — unique id per model so multiple planes on one page
  // don't collide. auto-start-reverse arms both ends.
  const markerId = `graph-arrow-${model.id}`;
  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: markerId, viewBox: '0 0 10 10', refX: 8, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
  });
  marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: COLOR_AXIS }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Gridlines.
  const gGrid = svgEl('g', { class: 'graphblock__gridlines' });
  for (let x = view.xMin; x <= view.xMax + 1e-9; x += tickStep) {
    const a = mathToPx(view, x, view.yMin);
    const b = mathToPx(view, x, view.yMax);
    gGrid.appendChild(svgEl('line', { x1: a.px, y1: a.py, x2: b.px, y2: b.py, stroke: COLOR_GRID, 'stroke-width': 1 }));
  }
  for (let y = view.yMin; y <= view.yMax + 1e-9; y += tickStep) {
    const a = mathToPx(view, view.xMin, y);
    const b = mathToPx(view, view.xMax, y);
    gGrid.appendChild(svgEl('line', { x1: a.px, y1: a.py, x2: b.px, y2: b.py, stroke: COLOR_GRID, 'stroke-width': 1 }));
  }
  svg.appendChild(gGrid);

  // Axes (with arrowheads at both ends).
  const origin = mathToPx(view, 0, 0);
  const xLeft = mathToPx(view, view.xMin, 0);
  const xRight = mathToPx(view, view.xMax, 0);
  const yBottom = mathToPx(view, 0, view.yMin);
  const yTop = mathToPx(view, 0, view.yMax);
  const xAxis = svgEl('line', {
    x1: xLeft.px, y1: xLeft.py, x2: xRight.px, y2: xRight.py,
    stroke: COLOR_AXIS, 'stroke-width': 1.6
  });
  xAxis.setAttribute('marker-start', `url(#${markerId})`);
  xAxis.setAttribute('marker-end', `url(#${markerId})`);
  const yAxis = svgEl('line', {
    x1: yBottom.px, y1: yBottom.py, x2: yTop.px, y2: yTop.py,
    stroke: COLOR_AXIS, 'stroke-width': 1.6
  });
  yAxis.setAttribute('marker-start', `url(#${markerId})`);
  yAxis.setAttribute('marker-end', `url(#${markerId})`);
  svg.append(xAxis, yAxis);

  // Tick labels (skip 0 to avoid overlapping the axes; one "0" at the origin).
  const gLabels = svgEl('g', { class: 'graphblock__labels' });
  const mkText = (px, py, text, anchor) => {
    const t = svgEl('text', { x: px, y: py, fill: COLOR_LABEL, 'font-size': 11, 'text-anchor': anchor });
    t.textContent = text;
    return t;
  };
  for (let x = view.xMin; x <= view.xMax + 1e-9; x += tickStep) {
    if (Math.abs(x) < 1e-9) continue;
    const p = mathToPx(view, x, 0);
    gLabels.appendChild(mkText(p.px, p.py + 14, fmt(x), 'middle'));
  }
  for (let y = view.yMin; y <= view.yMax + 1e-9; y += tickStep) {
    if (Math.abs(y) < 1e-9) continue;
    const p = mathToPx(view, 0, y);
    gLabels.appendChild(mkText(p.px - 6, p.py + 4, fmt(y), 'end'));
  }
  gLabels.appendChild(mkText(origin.px - 6, origin.py + 14, '0', 'end'));
  gLabels.appendChild(mkText(xRight.px - 2, xRight.py + 16, 'x', 'middle'));
  gLabels.appendChild(mkText(yTop.px + 14, yTop.py + 4, 'y', 'middle'));
  svg.appendChild(gLabels);

  // Dynamic layers: lines below points; equations above lines; coordinate
  // labels above everything the kid draws; ghost on top.
  const gLines = svgEl('g', { class: 'graphblock__lines' });
  const gPoints = svgEl('g', { class: 'graphblock__points' });
  const gEquations = svgEl('g', { class: 'graphblock__equations' });
  const gCoordLabels = svgEl('g', { class: 'graphblock__coordlabels' });
  const gGhost = svgEl('g', { class: 'graphblock__ghost' });
  svg.append(gLines, gPoints, gEquations, gCoordLabels, gGhost);

  // Delete-selected button (HTML overlay, shown only while something is selected).
  const delSel = document.createElement('button');
  delSel.type = 'button';
  delSel.className = 'graphblock__del-point';
  delSel.hidden = true;

  plot.append(svg, delSel);
  plane.append(bar, fnPanel, coordPanel, plot);

  // ---------- state ----------
  let mode = 'point';            // 'point' | 'line' | 'segment' | 'coord'
  let selection = null;          // { type:'point'|'line'|'label', id }
  let pending = null;            // first endpoint {x,y} while drawing a line/segment
  let fnOpen = false;
  let fnDraft = { m: 1, b: 0 };
  let fnEditId = null;           // when editing an existing 'mxb' line
  let coordOpen = false;
  // Draft label: anchor is where the tap landed; vx/vy are the values the
  // kid steps to. Values start at 0 (NOT at the anchor position) — filling
  // in the coordinates is his exercise, not the app's.
  let coordDraft = { anchor: null, vx: 0, vy: 0 };
  let coordEditId = null;        // when editing an existing label

  const findPoint = (id) => model.points.find((p) => p.id === id) || null;
  const findLine = (id) => model.lines.find((l) => l.id === id) || null;
  const findLabel = (id) => model.labels.find((l) => l.id === id) || null;
  const labelText = (vx, vy) => `(${fmtDisp(vx)}, ${fmtDisp(vy)})`;

  // ---------- read-out ----------
  const refreshReadout = () => {
    let text = '';
    let hint = false;
    if (pending) {
      text = 'הקש על הנקודה השנייה'; hint = true;
    } else if (mode === 'line') {
      text = 'הקש על שתי נקודות ליצירת קו'; hint = true;
    } else if (mode === 'segment') {
      text = 'הקש על שתי נקודות ליצירת קטע'; hint = true;
    } else if (mode === 'coord' && !coordOpen) {
      text = 'הקש על הרשת במקום שבו תרצה את התווית'; hint = true;
    } else if (mode === 'coord' && coordOpen) {
      text = 'מלא את השיעורים ואשר'; hint = true;
    } else if (selection && selection.type === 'point') {
      const p = findPoint(selection.id);
      if (p) text = `(${fmt(p.x)}, ${fmt(p.y)})`;
    } else if (selection && selection.type === 'label') {
      const l = findLabel(selection.id);
      if (l) text = labelText(l.vx, l.vy);
    } else if (selection && selection.type === 'line') {
      const l = findLine(selection.id);
      if (l) text = l.kind === 'segment' ? 'קטע' : formatEquation(l);
    } else {
      text = 'הקש על הרשת כדי להוסיף נקודה'; hint = true;
    }
    readout.textContent = text;
    readout.classList.toggle('graphblock__readout--hint', hint);
  };

  // ---------- delete-selected overlay ----------
  const positionDelSel = () => {
    if (!selection) { delSel.hidden = true; return; }
    let anchor = null;
    let label = '';
    if (selection.type === 'point') {
      const p = findPoint(selection.id);
      if (p) { anchor = mathToPx(view, p.x, p.y); label = 'מחק נקודה'; }
    } else if (selection.type === 'label') {
      const l = findLabel(selection.id);
      if (l) { anchor = mathToPx(view, l.x, l.y); label = 'מחק תווית'; }
    } else {
      const l = findLine(selection.id);
      if (l) {
        if (l.kind === 'segment') {
          anchor = mathToPx(view, (l.p1.x + l.p2.x) / 2, (l.p1.y + l.p2.y) / 2);
          label = 'מחק קטע';
        } else {
          const [e1, e2] = lineEndpoints(view, l);
          const clip = clipLineToView(view, e1, e2);
          if (clip) anchor = mathToPx(view, (clip.a.x + clip.b.x) / 2, (clip.a.y + clip.b.y) / 2);
          label = 'מחק קו';
        }
      }
    }
    if (!anchor) { delSel.hidden = true; return; }
    delSel.textContent = label;
    delSel.style.left = `${(anchor.px / vbW) * 100}%`;
    delSel.style.top = `${(anchor.py / vbH) * 100}%`;
    delSel.hidden = false;
  };

  // ---------- draw ----------
  const drawPoints = () => {
    gPoints.textContent = '';
    for (const p of model.points) {
      const px = mathToPx(view, p.x, p.y);
      const isSel = selection && selection.type === 'point' && selection.id === p.id;
      const c = svgEl('circle', {
        cx: px.px, cy: px.py, r: isSel ? 7 : 5.5,
        fill: isSel ? COLOR_POINT_SEL : COLOR_POINT,
        stroke: '#fff', 'stroke-width': 2
      });
      c.style.pointerEvents = 'none';
      gPoints.appendChild(c);
    }
  };

  const drawLines = () => {
    gLines.textContent = '';
    gEquations.textContent = '';
    model.lines.forEach((ln, i) => {
      const color = ln.color || LINE_COLORS[i % LINE_COLORS.length];
      const sel = selection && selection.type === 'line' && selection.id === ln.id;
      const w = sel ? 4 : 2.5;
      if (ln.kind === 'segment') {
        if (!ln.p1 || !ln.p2) return;
        const a = mathToPx(view, ln.p1.x, ln.p1.y);
        const b = mathToPx(view, ln.p2.x, ln.p2.y);
        gLines.appendChild(svgEl('line', { x1: a.px, y1: a.py, x2: b.px, y2: b.py, stroke: color, 'stroke-width': w, 'stroke-linecap': 'round' }));
        for (const e of [a, b]) {
          const d = svgEl('circle', { cx: e.px, cy: e.py, r: 4, fill: color, stroke: '#fff', 'stroke-width': 1.5 });
          d.style.pointerEvents = 'none';
          gLines.appendChild(d);
        }
      } else {
        const [e1, e2] = lineEndpoints(view, ln);
        if (!e1 || !e2) return;
        const clip = clipLineToView(view, e1, e2);
        if (!clip) return;
        const a = mathToPx(view, clip.a.x, clip.a.y);
        const b = mathToPx(view, clip.b.x, clip.b.y);
        const el = svgEl('line', { x1: a.px, y1: a.py, x2: b.px, y2: b.py, stroke: color, 'stroke-width': w });
        el.setAttribute('marker-start', `url(#${markerId})`);
        el.setAttribute('marker-end', `url(#${markerId})`);
        gLines.appendChild(el);
        if (ln.showEquation) {
          const t = svgEl('text', { x: (a.px + b.px) / 2 + 6, y: (a.py + b.py) / 2 - 6, fill: color, 'font-size': 12, 'font-weight': 600 });
          t.textContent = formatEquation(ln);
          gEquations.appendChild(t);
        }
      }
    });
  };

  // Coordinate labels: bold ink text with a white halo (paint-order) so the
  // "(3, 4)" stays readable over gridlines, lines and the worksheet behind an
  // on-worksheet graph. Offset up-right from the anchor so the label sits
  // beside a lattice point instead of covering it.
  const drawCoordLabels = () => {
    gCoordLabels.textContent = '';
    for (const l of model.labels) {
      const p = mathToPx(view, l.x, l.y);
      const isSel = selection && selection.type === 'label' && selection.id === l.id;
      const t = svgEl('text', {
        x: p.px + 7, y: p.py - 7,
        fill: isSel ? COLOR_POINT_SEL : COLOR_AXIS,
        'font-size': 13, 'font-weight': 700,
        stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke'
      });
      t.textContent = labelText(l.vx, l.vy);
      t.style.pointerEvents = 'none';
      gCoordLabels.appendChild(t);
    }
  };

  const drawGhost = () => {
    gGhost.textContent = '';
    if (mode === 'coord' && coordOpen && coordDraft.anchor) {
      // Live preview of the label being edited, at its placement spot.
      const p = mathToPx(view, coordDraft.anchor.x, coordDraft.anchor.y);
      gGhost.appendChild(svgEl('circle', {
        cx: p.px, cy: p.py, r: 4,
        fill: 'none', stroke: COLOR_PREVIEW, 'stroke-width': 2, 'stroke-dasharray': '3 2'
      }));
      const t = svgEl('text', {
        x: p.px + 7, y: p.py - 7,
        fill: COLOR_PREVIEW, 'font-size': 13, 'font-weight': 700,
        stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke'
      });
      t.textContent = labelText(coordDraft.vx, coordDraft.vy);
      gGhost.appendChild(t);
    }
    if (pending) {
      const p = mathToPx(view, pending.x, pending.y);
      gGhost.appendChild(svgEl('circle', { cx: p.px, cy: p.py, r: 6, fill: 'none', stroke: COLOR_POINT, 'stroke-width': 2, 'stroke-dasharray': '3 2' }));
    }
    if (fnOpen) {
      const clip = clipLineToView(view,
        { x: view.xMin, y: fnDraft.m * view.xMin + fnDraft.b },
        { x: view.xMax, y: fnDraft.m * view.xMax + fnDraft.b });
      if (clip) {
        const a = mathToPx(view, clip.a.x, clip.a.y);
        const b = mathToPx(view, clip.b.x, clip.b.y);
        gGhost.appendChild(svgEl('line', { x1: a.px, y1: a.py, x2: b.px, y2: b.py, stroke: COLOR_PREVIEW, 'stroke-width': 2.5, 'stroke-dasharray': '6 4' }));
      }
    }
  };

  const redraw = () => {
    drawLines();
    drawPoints();
    drawCoordLabels();
    drawGhost();
    positionDelSel();
    refreshReadout();
  };

  // ---------- selection ----------
  const selectPoint = (id) => { selection = { type: 'point', id }; redraw(); };
  const selectLine = (id) => { selection = { type: 'line', id }; redraw(); };
  const selectLabel = (id) => { selection = { type: 'label', id }; redraw(); };

  // ---------- mode / tools ----------
  const updateToolButtons = () => {
    for (const btn of tools.children) {
      const v = btn.dataset.tool;
      btn.classList.toggle('graphblock__tool--active', v === 'fn' ? fnOpen : v === mode);
    }
  };

  const setMode = (m) => {
    mode = m;
    pending = null;
    // Leaving coord mode abandons any unconfirmed label draft.
    if (m !== 'coord' && coordOpen) closeCoordPanel();
    redraw();
    updateToolButtons();
  };

  tPoint.addEventListener('click', () => setMode('point'));
  if (tLine) tLine.addEventListener('click', () => setMode('line'));
  tSeg.addEventListener('click', () => setMode('segment'));
  tCoord.addEventListener('click', () => setMode(mode === 'coord' ? 'point' : 'coord'));

  // ---------- y=mx+b panel ----------
  let mValEl = null;
  let bValEl = null;
  let fnEqEl = null;
  let fnAddBtn = null;

  const refreshFnPanel = () => {
    if (mValEl) mValEl.textContent = fmtDisp(fnDraft.m);
    if (bValEl) bValEl.textContent = fmtDisp(fnDraft.b);
    if (fnEqEl) fnEqEl.textContent = formatEquation({ kind: 'mxb', m: fnDraft.m, b: fnDraft.b });
    if (fnAddBtn) fnAddBtn.textContent = fnEditId ? 'עדכון' : 'הוספה';
  };

  const buildFnPanel = () => {
    fnPanel.textContent = '';
    const eq = document.createElement('div');
    eq.className = 'graphblock__fn-preview';
    fnEqEl = eq;

    const mkStepper = (caption, setDelta) => {
      const wrap = document.createElement('div');
      wrap.className = 'graphblock__fn-stepper';
      const cap = document.createElement('span');
      cap.className = 'graphblock__fn-cap';
      cap.textContent = caption;
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'graphblock__fn-btn';
      minus.textContent = MINUS;
      minus.setAttribute('aria-label', `הקטנה ${caption}`);
      const val = document.createElement('span');
      val.className = 'graphblock__fn-val';
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'graphblock__fn-btn';
      plus.textContent = '+';
      plus.setAttribute('aria-label', `הגדלה ${caption}`);
      minus.addEventListener('click', () => { setDelta(-FN_STEP); });
      plus.addEventListener('click', () => { setDelta(+FN_STEP); });
      wrap.append(cap, minus, val, plus);
      return { wrap, val };
    };

    const mS = mkStepper('שיפוע m', (d) => {
      fnDraft.m = clamp(fnDraft.m + d, FN_MIN, FN_MAX);
      refreshFnPanel(); drawGhost();
    });
    const bS = mkStepper('חיתוך b', (d) => {
      fnDraft.b = clamp(fnDraft.b + d, FN_MIN, FN_MAX);
      refreshFnPanel(); drawGhost();
    });
    mValEl = mS.val;
    bValEl = bS.val;

    const actions = document.createElement('div');
    actions.className = 'graphblock__fn-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'graphblock__fn-add';
    fnAddBtn = addBtn;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'graphblock__fn-cancel';
    cancelBtn.textContent = 'ביטול';
    addBtn.addEventListener('click', () => {
      onEditStart();
      if (fnEditId) {
        const l = findLine(fnEditId);
        if (l) { l.m = fnDraft.m; l.b = fnDraft.b; }
      } else {
        model.lines.push(newGraphLine({
          kind: 'mxb', m: fnDraft.m, b: fnDraft.b,
          color: LINE_COLORS[model.lines.length % LINE_COLORS.length]
        }));
      }
      closeFnPanel();
      redraw();
      onChange();
    });
    cancelBtn.addEventListener('click', () => { closeFnPanel(); redraw(); });
    actions.append(addBtn, cancelBtn);

    fnPanel.append(eq, mS.wrap, bS.wrap, actions);
    refreshFnPanel();
  };

  const openFnPanel = () => {
    if (selection && selection.type === 'line') {
      const l = findLine(selection.id);
      if (l && l.kind === 'mxb') { fnDraft = { m: l.m, b: l.b }; fnEditId = l.id; }
      else { fnDraft = { m: 1, b: 0 }; fnEditId = null; }
    } else {
      fnDraft = { m: 1, b: 0 };
      fnEditId = null;
    }
    fnOpen = true;
    fnPanel.hidden = false;
    buildFnPanel();
    drawGhost();
    updateToolButtons();
  };

  function closeFnPanel() {
    fnOpen = false;
    fnEditId = null;
    fnPanel.hidden = true;
    updateToolButtons();
  }

  if (tFn) {
    tFn.addEventListener('click', () => {
      if (fnOpen) { closeFnPanel(); redraw(); }
      else { setMode('point'); openFnPanel(); }
    });
  }

  // ---------- coordinate-label panel ----------
  // Same stepper interaction as the y=mx+b panel the kid already knows:
  // the "( , )" structure is preloaded — he places it with a tap, then
  // steps the x and y values and confirms. Steppers move by snapStep
  // (whole units by default) between the view bounds.
  let coordPreviewEl = null;
  let coordAddBtn = null;

  const refreshCoordPanel = () => {
    if (coordPreviewEl) coordPreviewEl.textContent = labelText(coordDraft.vx, coordDraft.vy);
    if (coordAddBtn) coordAddBtn.textContent = coordEditId ? 'עדכון' : 'אישור';
    drawGhost();
  };

  const buildCoordPanel = () => {
    coordPanel.textContent = '';
    const preview = document.createElement('div');
    preview.className = 'graphblock__fn-preview';
    coordPreviewEl = preview;

    const mkValStepper = (caption, get, set, lo, hi) => {
      const wrap = document.createElement('div');
      wrap.className = 'graphblock__fn-stepper';
      const cap = document.createElement('span');
      cap.className = 'graphblock__fn-cap';
      cap.textContent = caption;
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'graphblock__fn-btn';
      minus.textContent = MINUS;
      minus.setAttribute('aria-label', `הקטנה ${caption}`);
      const val = document.createElement('span');
      val.className = 'graphblock__fn-val';
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'graphblock__fn-btn';
      plus.textContent = '+';
      plus.setAttribute('aria-label', `הגדלה ${caption}`);
      const paint = () => { val.textContent = fmtDisp(get()); };
      minus.addEventListener('click', () => {
        set(clamp(get() - snapStep, lo, hi));
        paint(); refreshCoordPanel();
      });
      plus.addEventListener('click', () => {
        set(clamp(get() + snapStep, lo, hi));
        paint(); refreshCoordPanel();
      });
      paint();
      wrap.append(cap, minus, val, plus);
      return wrap;
    };

    const xS = mkValStepper('x', () => coordDraft.vx, (v) => { coordDraft.vx = v; }, view.xMin, view.xMax);
    const yS = mkValStepper('y', () => coordDraft.vy, (v) => { coordDraft.vy = v; }, view.yMin, view.yMax);

    const actions = document.createElement('div');
    actions.className = 'graphblock__fn-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'graphblock__fn-add';
    coordAddBtn = addBtn;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'graphblock__fn-cancel';
    cancelBtn.textContent = 'ביטול';
    addBtn.addEventListener('click', () => {
      if (!coordDraft.anchor && !coordEditId) return;
      onEditStart();
      if (coordEditId) {
        const l = findLabel(coordEditId);
        if (l) { l.vx = coordDraft.vx; l.vy = coordDraft.vy; }
      } else {
        model.labels.push({
          id: graphPointId(),
          x: coordDraft.anchor.x,
          y: coordDraft.anchor.y,
          vx: coordDraft.vx,
          vy: coordDraft.vy
        });
      }
      closeCoordPanel();
      redraw();
      onChange();
    });
    cancelBtn.addEventListener('click', () => { closeCoordPanel(); redraw(); });
    actions.append(addBtn, cancelBtn);

    coordPanel.append(preview, xS, yS, actions);
    refreshCoordPanel();
  };

  const openCoordPanel = ({ anchor = null, editId = null } = {}) => {
    if (editId) {
      const l = findLabel(editId);
      coordDraft = l
        ? { anchor: { x: l.x, y: l.y }, vx: l.vx, vy: l.vy }
        : { anchor, vx: 0, vy: 0 };
      coordEditId = l ? editId : null;
    } else {
      coordDraft = { anchor, vx: 0, vy: 0 };
      coordEditId = null;
    }
    coordOpen = true;
    coordPanel.hidden = false;
    buildCoordPanel();
    refreshReadout();
    drawGhost();
  };

  function closeCoordPanel() {
    coordOpen = false;
    coordEditId = null;
    coordDraft = { anchor: null, vx: 0, vy: 0 };
    coordPanel.hidden = true;
    coordPanel.textContent = '';
  }

  // ---------- canvas pointer handling ----------
  const clientToMath = (clientX, clientY) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    return pxToMath(view, loc.x, loc.y);
  };

  const nearestPoint = (mx, my) => {
    let best = null;
    let bestD = HIT_RADIUS;
    for (const p of model.points) {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  };

  const nearestLine = (mx, my) => {
    let best = null;
    let bestD = LINE_HIT;
    const P = { x: mx, y: my };
    for (const ln of model.lines) {
      let d;
      if (ln.kind === 'segment') d = distToSegment(P, ln.p1, ln.p2);
      else { const [e1, e2] = lineEndpoints(view, ln); d = distToLine(P, e1, e2); }
      if (d <= bestD) { bestD = d; best = ln; }
    }
    return best;
  };

  const nearestLabel = (mx, my) => {
    let best = null;
    let bestD = HIT_RADIUS;
    for (const l of model.labels) {
      const d = Math.hypot(l.x - mx, l.y - my);
      if (d <= bestD) { bestD = d; best = l; }
    }
    return best;
  };

  const snapM = (m) => ({
    x: clamp(snap(m.x, snapStep), view.xMin, view.xMax),
    y: clamp(snap(m.y, snapStep), view.yMin, view.yMax)
  });

  let active = null; // point-drag gesture: { id, undoPushed }

  svg.addEventListener('pointerdown', (e) => {
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;
    e.preventDefault();

    if (mode === 'coord') {
      // Tap an existing label to edit it; tap anywhere else to (re)place
      // the draft label's anchor — re-tapping before confirming just moves
      // it, so "decide where to place it" stays cheap to change.
      const labelHit = nearestLabel(m.x, m.y);
      if (labelHit) {
        selectLabel(labelHit.id);
        openCoordPanel({ editId: labelHit.id });
        return;
      }
      const anchor = snapM(m);
      if (coordOpen && !coordEditId) {
        coordDraft.anchor = anchor;
        refreshReadout();
        drawGhost();
      } else {
        openCoordPanel({ anchor });
      }
      return;
    }

    if (mode === 'line' || mode === 'segment') {
      const s = snapM(m);
      if (!pending) {
        pending = s;
        refreshReadout();
        drawGhost();
      } else if (s.x === pending.x && s.y === pending.y) {
        // ignore a duplicate second tap on the same lattice point
      } else {
        onEditStart();
        model.lines.push(newGraphLine({
          kind: mode === 'line' ? 'line' : 'segment',
          p1: pending, p2: s,
          color: LINE_COLORS[model.lines.length % LINE_COLORS.length]
        }));
        pending = null;
        redraw();
        onChange();
      }
      return;
    }

    // point mode
    const hit = nearestPoint(m.x, m.y);
    if (hit) {
      active = { id: hit.id, undoPushed: false };
      selectPoint(hit.id);
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    // Labels are selectable in point mode too (to delete or re-edit one
    // without hunting for the (x,y) tool) — but AFTER the point hit-test,
    // so a label sitting next to its point never steals the point's tap.
    const labelHit = nearestLabel(m.x, m.y);
    if (labelHit) {
      selectLabel(labelHit.id);
      return;
    }
    const lineHit = nearestLine(m.x, m.y);
    if (lineHit) {
      selectLine(lineHit.id);
      return;
    }
    // empty space → drop a new snapped point
    onEditStart();
    const np = { id: graphPointId(), ...snapM(m) };
    model.points.push(np);
    active = { id: np.id, undoPushed: true };
    selectPoint(np.id);
    onChange();
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  });

  svg.addEventListener('pointermove', (e) => {
    if (!active) return;
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;
    const p = findPoint(active.id);
    if (!p) return;
    const s = snapM(m);
    if (s.x === p.x && s.y === p.y) return;
    if (!active.undoPushed) { onEditStart(); active.undoPushed = true; }
    p.x = s.x;
    p.y = s.y;
    redraw();
  });

  const endGesture = (e) => {
    if (!active) return;
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    if (active.undoPushed) onChange();
    active = null;
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);

  // ---------- delete-selected / clear ----------
  delSel.addEventListener('pointerdown', (e) => e.stopPropagation());
  delSel.addEventListener('click', () => {
    if (!selection) return;
    onEditStart();
    if (selection.type === 'point') {
      model.points = model.points.filter((p) => p.id !== selection.id);
    } else if (selection.type === 'label') {
      model.labels = model.labels.filter((l) => l.id !== selection.id);
      if (coordEditId === selection.id) closeCoordPanel();
    } else {
      model.lines = model.lines.filter((l) => l.id !== selection.id);
    }
    selection = null;
    redraw();
    onChange();
  });

  clearBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  clearBtn.addEventListener('click', () => {
    if (model.points.length === 0 && model.lines.length === 0 &&
        model.labels.length === 0) return;
    onEditStart();
    model.points = [];
    model.lines = [];
    model.labels = [];
    selection = null;
    pending = null;
    if (coordOpen) closeCoordPanel();
    redraw();
    onChange();
  });

  // initial paint
  updateToolButtons();
  redraw();

  return plane;
}

// Standalone GRAPH block: a titled card wrapping the interactive plane plus a
// block-delete control. attachBlockChrome (editor.js) adds the drag handle.
export function renderGraphBlock(block, options = {}) {
  const { onEditStart = () => {}, onChange = () => {}, onDelete = () => {} } = options;

  const figure = document.createElement('figure');
  figure.className = 'graphblock';
  figure.setAttribute('dir', 'ltr');
  figure.dataset.blockId = block.id;

  const header = document.createElement('header');
  header.className = 'graphblock__header';
  header.setAttribute('dir', 'rtl');
  const title = document.createElement('span');
  title.className = 'graphblock__title';
  title.textContent = 'גרף';
  header.appendChild(title);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'graphblock__delete';
  del.textContent = '✕';
  del.title = 'הסרת הגרף';
  del.setAttribute('aria-label', 'הסרת הגרף');
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', () => onDelete(block.id));

  const plane = buildGraphPlane(block, { onEditStart, onChange });

  figure.append(header, del, plane);
  return figure;
}
