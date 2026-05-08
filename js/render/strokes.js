// Stroke rendering on a 2D canvas. Strokes are stored in CSS-pixel coordinates;
// the canvas renders at devicePixelRatio for crisp lines.

export function sizeCanvas(canvas, container) {
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Use the container's scroll size so strokes outside the viewport still
  // get drawn (the container scrolls; the canvas is full-extent).
  const width = container.scrollWidth || rect.width;
  const height = container.scrollHeight || rect.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
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
