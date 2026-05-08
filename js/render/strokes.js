// Stroke rendering on a 2D canvas. Strokes are stored in CSS-pixel coordinates;
// the canvas renders at devicePixelRatio for crisp lines.

export function sizeCanvas(canvas, container) {
  const dpr = window.devicePixelRatio || 1;
  // Temporarily collapse the canvas so it doesn't contribute to the
  // container's scroll size when we measure (otherwise growing the canvas
  // would feed back and grow the container, locking the size at the largest
  // value ever seen).
  const prevW = canvas.style.width;
  const prevH = canvas.style.height;
  canvas.style.width = '0px';
  canvas.style.height = '0px';
  const width = container.scrollWidth || container.getBoundingClientRect().width;
  const height = container.scrollHeight || container.getBoundingClientRect().height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  // (prevW/prevH no longer needed; we set the new sizes.)
  void prevW; void prevH;
  return dpr;
}

export function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function strokeStyle(ctx, stroke) {
  if (stroke.eraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color || '#111';
    ctx.fillStyle = ctx.strokeStyle;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

export function renderStroke(ctx, stroke, dpr = 1) {
  if (!stroke.points || stroke.points.length === 0) return;
  ctx.save();
  strokeStyle(ctx, stroke);
  const base = (stroke.width || 2.4) * dpr;
  const pts = stroke.points;

  if (pts.length === 1) {
    const p = pts[0];
    const r = Math.max(0.5, base * (p.p || 0.5) * 0.6);
    ctx.beginPath();
    ctx.arc(p.x * dpr, p.y * dpr, r, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const w = base * Math.max(0.25, (a.p + b.p) / 2);
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x * dpr, a.y * dpr);
      ctx.lineTo(b.x * dpr, b.y * dpr);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function renderStrokeIncremental(ctx, stroke, fromIndex, dpr = 1) {
  const pts = stroke.points;
  if (!pts || pts.length < 2 || fromIndex >= pts.length) return;
  ctx.save();
  strokeStyle(ctx, stroke);
  const base = (stroke.width || 2.4) * dpr;
  const start = Math.max(1, fromIndex);
  for (let i = start; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const w = base * Math.max(0.25, (a.p + b.p) / 2);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x * dpr, a.y * dpr);
    ctx.lineTo(b.x * dpr, b.y * dpr);
    ctx.stroke();
  }
  ctx.restore();
}

export function replayStrokes(canvas, strokes) {
  clearCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  for (const s of strokes) renderStroke(ctx, s, dpr);
}
