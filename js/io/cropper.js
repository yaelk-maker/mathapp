// In-app image cropper. Shown after the user picks/captures a photo,
// before the file is saved as a worksheet block. Draggable rectangle with
// 4 corner handles + body drag to move. Returns a new File with the cropped
// region, or the original File if the user cancelled.

const HANDLE_SIZE = 40;       // hit-target size for corner handles (CSS px)
const MIN_RECT = 40;          // minimum crop rectangle width/height (CSS px)

export function cropImageFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      showCropperUI({ img, originalFile: file, objectUrl: url, done: resolve });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file); // fall back to original
    };
    img.src = url;
  });
}

function showCropperUI({ img, originalFile, objectUrl, done }) {
  const overlay = document.createElement('div');
  overlay.className = 'crop-overlay';
  overlay.dir = 'rtl';
  overlay.innerHTML = `
    <div class="crop-overlay__bar crop-overlay__bar--top">
      <div class="crop-overlay__title">חתוך תמונה</div>
    </div>
    <div class="crop-overlay__stage" id="crop-stage">
      <div class="crop-overlay__imgwrap" id="crop-imgwrap">
        <img class="crop-overlay__img" id="crop-img" alt="" draggable="false">
        <div class="crop-rect" id="crop-rect">
          <div class="crop-handle" data-handle="nw"></div>
          <div class="crop-handle" data-handle="ne"></div>
          <div class="crop-handle" data-handle="sw"></div>
          <div class="crop-handle" data-handle="se"></div>
        </div>
      </div>
    </div>
    <div class="crop-overlay__bar crop-overlay__bar--bottom">
      <button class="btn btn--ghost" id="crop-cancel">ביטול</button>
      <button class="btn btn--ghost" id="crop-skip">השתמש בכל התמונה</button>
      <button class="btn" id="crop-apply">חתוך ואשר</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const stage = overlay.querySelector('#crop-stage');
  const imgEl = overlay.querySelector('#crop-img');
  const imgWrap = overlay.querySelector('#crop-imgwrap');
  const rectEl = overlay.querySelector('#crop-rect');

  imgEl.src = objectUrl;

  // After the image is placed, size the wrapper to match its displayed
  // dimensions so we can position the crop rect in those coordinates.
  let displayedW = 0;
  let displayedH = 0;
  let imgLeft = 0;
  let imgTop = 0;

  function layout() {
    const stageRect = stage.getBoundingClientRect();
    const stageW = stageRect.width - 32;
    const stageH = stageRect.height - 32;
    if (stageW <= 0 || stageH <= 0) return;
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const stageRatio = stageW / stageH;
    if (imgRatio > stageRatio) {
      displayedW = stageW;
      displayedH = stageW / imgRatio;
    } else {
      displayedH = stageH;
      displayedW = stageH * imgRatio;
    }
    imgLeft = (stageRect.width - displayedW) / 2;
    imgTop = (stageRect.height - displayedH) / 2;
    imgWrap.style.left = imgLeft + 'px';
    imgWrap.style.top = imgTop + 'px';
    imgWrap.style.width = displayedW + 'px';
    imgWrap.style.height = displayedH + 'px';

    // Initial crop rect: 80% of image, centered
    const cropW = displayedW * 0.8;
    const cropH = displayedH * 0.8;
    setRect((displayedW - cropW) / 2, (displayedH - cropH) / 2, cropW, cropH);
  }

  // Crop rect state in displayed-image coords (origin at image top-left)
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  function setRect(x, y, w, h) {
    rect = {
      x: clamp(x, 0, displayedW),
      y: clamp(y, 0, displayedH),
      w: clamp(w, MIN_RECT, displayedW - x),
      h: clamp(h, MIN_RECT, displayedH - y)
    };
    // Re-clamp based on width
    rect.w = Math.min(rect.w, displayedW - rect.x);
    rect.h = Math.min(rect.h, displayedH - rect.y);
    rectEl.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    rectEl.style.width = rect.w + 'px';
    rectEl.style.height = rect.h + 'px';
  }

  // Drag handling
  let drag = null; // { kind: 'move'|'nw'|..., startX, startY, startRect }

  function onPointerDown(event) {
    const handle = event.target.closest('.crop-handle');
    const insideRect = event.target === rectEl;
    if (!handle && !insideRect) return;

    drag = {
      kind: handle ? handle.dataset.handle : 'move',
      startX: event.clientX,
      startY: event.clientY,
      startRect: { ...rect }
    };
    event.target.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const s = drag.startRect;
    let { x, y, w, h } = s;

    switch (drag.kind) {
      case 'move':
        x = s.x + dx;
        y = s.y + dy;
        break;
      case 'nw':
        x = s.x + dx;
        y = s.y + dy;
        w = s.w - dx;
        h = s.h - dy;
        break;
      case 'ne':
        y = s.y + dy;
        w = s.w + dx;
        h = s.h - dy;
        break;
      case 'sw':
        x = s.x + dx;
        w = s.w - dx;
        h = s.h + dy;
        break;
      case 'se':
        w = s.w + dx;
        h = s.h + dy;
        break;
    }
    // Clamp before applying so resize from a corner doesn't tear off
    if (w < MIN_RECT) {
      if (drag.kind === 'nw' || drag.kind === 'sw') x = s.x + s.w - MIN_RECT;
      w = MIN_RECT;
    }
    if (h < MIN_RECT) {
      if (drag.kind === 'nw' || drag.kind === 'ne') y = s.y + s.h - MIN_RECT;
      h = MIN_RECT;
    }
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > displayedW) { w = displayedW - x; }
    if (y + h > displayedH) { h = displayedH - y; }

    setRect(x, y, w, h);
    event.preventDefault();
  }

  function onPointerUp() { drag = null; }

  rectEl.addEventListener('pointerdown', onPointerDown);
  for (const h of rectEl.querySelectorAll('.crop-handle')) {
    h.addEventListener('pointerdown', onPointerDown);
  }
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // Buttons
  overlay.querySelector('#crop-cancel').addEventListener('click', () => {
    cleanup();
    done(null); // user fully cancelled — no upload
  });
  overlay.querySelector('#crop-skip').addEventListener('click', () => {
    cleanup();
    done(originalFile); // use the original
  });
  overlay.querySelector('#crop-apply').addEventListener('click', async () => {
    const cropped = await produceCroppedFile(img, originalFile, rect, { displayedW, displayedH });
    cleanup();
    done(cropped);
  });

  function cleanup() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    overlay.remove();
    URL.revokeObjectURL(objectUrl);
  }

  // Initial layout. Wait one frame for the overlay to receive its size.
  requestAnimationFrame(() => {
    layout();
    // Re-layout on resize/orientation change (in case the user rotates the iPad).
    const ro = new ResizeObserver(() => layout());
    ro.observe(stage);
    overlay.dataset.cleanupResize = '1';
    overlay.__ro = ro;
  });
}

async function produceCroppedFile(img, originalFile, rect, displayed) {
  const scale = img.naturalWidth / displayed.displayedW;
  const sx = Math.round(rect.x * scale);
  const sy = Math.round(rect.y * scale);
  const sw = Math.round(rect.w * scale);
  const sh = Math.round(rect.h * scale);

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const mimeType = originalFile.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((res) => canvas.toBlob(res, mimeType, 0.92));
  if (!blob) return originalFile;
  // Preserve the original name (so the worksheet block keeps a sensible filename).
  return new File([blob], originalFile.name || 'cropped.jpg', { type: mimeType });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
