// Renders a GRAPH block as an inline-SVG coordinate plane.
//
// Math convention: +x to the right, +y up. The figure is dir="ltr" even on an
// RTL page (exactly like the workblock grid) because a coordinate system reads
// left-to-right in a Hebrew classroom too; only descriptive text would be RTL.
//
// SVG (not Canvas) is deliberate: axes/ticks stay crisp at any display size
// with no devicePixelRatio bookkeeping, taps hit-test in math space with a
// single getScreenCTM() inverse, and PDF print stays vector-sharp. The
// page-spanning pencil canvas sits ABOVE every block, so when pen mode is on
// the canvas captures pointers and the graph is automatically inert — no
// extra mutex needed here.

import { graphPointId } from '../page-model.js';

const SVGNS = 'http://www.w3.org/2000/svg';

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

// MAËLYS-leaning neutrals for the static plane; the app's accent blue for the
// interactive points so they read as "the thing you place", consistent with
// every other tappable element in the app.
const COLOR_GRID = '#EBE5E2';
const COLOR_AXIS = '#120D0E';
const COLOR_LABEL = '#5A524D';
const COLOR_POINT = '#0b6cf2';
const COLOR_POINT_SEL = '#0958c4';

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

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Format a math value for a label / read-out, trimming a trailing ".0" so
// integers read as "3" not "3.0" while a half-step still shows "2.5".
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function renderGraphBlock(block, options = {}) {
  const {
    onEditStart = () => {},   // pushUndo — called once per gesture before the first mutation
    onChange = () => {},      // queueSave — called after points actually change
    onDelete = () => {}       // removeBlock(id)
  } = options;

  const view = block.view;
  const snapStep = block.snapStep > 0 ? block.snapStep : 1;
  const tickStep = block.tickStep > 0 ? block.tickStep : 1;
  if (!Array.isArray(block.points)) block.points = [];

  const vbW = (view.xMax - view.xMin) * UNIT + PAD * 2;
  const vbH = (view.yMax - view.yMin) * UNIT + PAD * 2;

  const figure = document.createElement('figure');
  figure.className = 'graphblock';
  figure.setAttribute('dir', 'ltr');
  figure.dataset.blockId = block.id;

  // ---- header: title + live read-out + clear ----
  const header = document.createElement('header');
  header.className = 'graphblock__header';
  header.setAttribute('dir', 'rtl');

  const title = document.createElement('span');
  title.className = 'graphblock__title';
  title.textContent = 'גרף';

  const readout = document.createElement('span');
  readout.className = 'graphblock__readout';
  // dir="ltr" so "(x, y)" and the Hebrew hint each read naturally; the parens
  // and numbers stay in math order.
  readout.setAttribute('dir', 'ltr');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'graphblock__clear';
  clearBtn.textContent = 'נקה';
  clearBtn.title = 'מחיקת כל הנקודות';
  clearBtn.setAttribute('aria-label', 'מחיקת כל הנקודות');

  header.append(title, readout, clearBtn);

  // ---- block delete (top-start circle), styled like the workblock's ----
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'graphblock__delete';
  del.textContent = '✕';
  del.title = 'הסרת הגרף';
  del.setAttribute('aria-label', 'הסרת הגרף');
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', () => onDelete(block.id));

  // ---- plot area (svg + overlaid delete-point button) ----
  const plot = document.createElement('div');
  plot.className = 'graphblock__plot';
  // Match the container box to the viewBox aspect so % positioning of the
  // HTML delete-point overlay maps 1:1 onto SVG pixels (no letterboxing).
  plot.style.aspectRatio = `${vbW} / ${vbH}`;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${vbW} ${vbH}`,
    class: 'graphblock__svg',
    role: 'img',
    'aria-label': 'מערכת צירים'
  });

  // Arrowhead marker — unique id per block so multiple graphs on one page
  // don't collide. auto-start-reverse lets one marker arm both ends.
  const markerId = `graph-arrow-${block.id}`;
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
  // Axis letters.
  gLabels.appendChild(mkText(xRight.px - 2, xRight.py + 16, 'x', 'middle'));
  gLabels.appendChild(mkText(yTop.px + 14, yTop.py + 4, 'y', 'middle'));
  svg.appendChild(gLabels);

  // Points layer — rebuilt on every change.
  const gPoints = svgEl('g', { class: 'graphblock__points' });
  svg.appendChild(gPoints);

  // Delete-point button (HTML overlay, shown only while a point is selected).
  const delPoint = document.createElement('button');
  delPoint.type = 'button';
  delPoint.className = 'graphblock__del-point';
  delPoint.textContent = 'מחק נקודה';
  delPoint.hidden = true;

  plot.append(svg, delPoint);
  figure.append(header, del, plot);

  // ---------- interaction ----------
  let selectedId = null;

  const setReadout = (p) => {
    if (p) {
      readout.textContent = `(${fmt(p.x)}, ${fmt(p.y)})`;
      readout.classList.remove('graphblock__readout--hint');
    } else {
      readout.textContent = 'הקישי על הרשת כדי להוסיף נקודה';
      readout.classList.add('graphblock__readout--hint');
    }
  };

  const positionDelPoint = (p) => {
    if (!p) { delPoint.hidden = true; return; }
    const px = mathToPx(view, p.x, p.y);
    delPoint.style.left = `${(px.px / vbW) * 100}%`;
    delPoint.style.top = `${(px.py / vbH) * 100}%`;
    delPoint.hidden = false;
  };

  const drawPoints = () => {
    gPoints.textContent = '';
    for (const p of block.points) {
      const px = mathToPx(view, p.x, p.y);
      const isSel = p.id === selectedId;
      const c = svgEl('circle', {
        cx: px.px, cy: px.py, r: isSel ? 7 : 5.5,
        fill: isSel ? COLOR_POINT_SEL : COLOR_POINT,
        stroke: '#fff', 'stroke-width': 2
      });
      c.style.pointerEvents = 'none';
      gPoints.appendChild(c);
    }
    positionDelPoint(block.points.find((p) => p.id === selectedId) || null);
  };

  const select = (id) => {
    selectedId = id;
    const p = block.points.find((q) => q.id === id) || null;
    setReadout(p);
    drawPoints();
  };

  setReadout(null);
  drawPoints();

  // Screen → math, via the SVG's current transform (handles the width:100%
  // scale and any device zoom). Returns null if the SVG isn't laid out yet.
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
    for (const p of block.points) {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  };

  let active = null; // { id, undoPushed, created }

  svg.addEventListener('pointerdown', (e) => {
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;
    e.preventDefault();
    const hit = nearestPoint(m.x, m.y);
    if (hit) {
      // Grab an existing point: select now, defer the undo snapshot until a
      // drag actually moves it (so a plain select doesn't spam undo history).
      active = { id: hit.id, undoPushed: false, created: false };
      select(hit.id);
    } else {
      // Empty space: drop a new snapped point inside the view.
      onEditStart();
      const np = {
        id: graphPointId(),
        x: clamp(snap(m.x, snapStep), view.xMin, view.xMax),
        y: clamp(snap(m.y, snapStep), view.yMin, view.yMax)
      };
      block.points.push(np);
      active = { id: np.id, undoPushed: true, created: true };
      select(np.id);
      onChange();
    }
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  });

  svg.addEventListener('pointermove', (e) => {
    if (!active) return;
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;
    const p = block.points.find((q) => q.id === active.id);
    if (!p) return;
    const nx = clamp(snap(m.x, snapStep), view.xMin, view.xMax);
    const ny = clamp(snap(m.y, snapStep), view.yMin, view.yMax);
    if (nx === p.x && ny === p.y) return;
    if (!active.undoPushed) { onEditStart(); active.undoPushed = true; }
    p.x = nx;
    p.y = ny;
    setReadout(p);
    drawPoints();
  });

  const endGesture = (e) => {
    if (!active) return;
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    // A drag (or a fresh placement) changed the data; a plain tap-select did not.
    if (active.undoPushed) onChange();
    active = null;
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);

  delPoint.addEventListener('pointerdown', (e) => e.stopPropagation());
  delPoint.addEventListener('click', () => {
    if (!selectedId) return;
    onEditStart();
    block.points = block.points.filter((p) => p.id !== selectedId);
    selectedId = null;
    setReadout(null);
    drawPoints();
    onChange();
  });

  clearBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  clearBtn.addEventListener('click', () => {
    if (block.points.length === 0) return;
    onEditStart();
    block.points = [];
    selectedId = null;
    setReadout(null);
    drawPoints();
    onChange();
  });

  return figure;
}
