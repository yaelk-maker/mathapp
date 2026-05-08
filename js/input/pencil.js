// Apple Pencil drawing layer.
// Captures Pointer Events with pointerType === 'pen' (or 'mouse' on desktop
// for testing). Touch events with palm/finger are ignored — that's the whole
// reason for using Pointer Events instead of Touch Events on iPadOS.

const FINGER_KIND = 'touch';

export function attachPencilSurface(canvas, options) {
  const {
    onStrokeStart,
    onStrokePoint,
    onStrokeEnd,
    isEnabled = () => true,
    allowFinger = false,
    getColor = () => '#111111',
    getWidth = () => 2.4,
    getEraserMode = () => false
  } = options;

  // Critical for iPadOS: prevents the page from scrolling when the Pencil
  // touches the canvas, AND prevents finger touches from triggering pointer
  // events when allowFinger is false.
  canvas.style.touchAction = 'none';

  let activePointerId = null;
  let activeStrokeId = null;

  function onPointerDown(event) {
    if (!isEnabled()) return;
    if (event.pointerType === FINGER_KIND && !allowFinger) return;
    if (activePointerId !== null) return; // ignore secondary pointers

    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);

    const point = makePoint(event, canvas);
    activeStrokeId = onStrokeStart({
      color: getColor(),
      width: getWidth(),
      eraser: getEraserMode(),
      pointerType: event.pointerType,
      point
    });

    event.preventDefault();
  }

  function onPointerMove(event) {
    if (event.pointerId !== activePointerId) return;
    if (!activeStrokeId) return;
    const point = makePoint(event, canvas);
    onStrokePoint(activeStrokeId, point);
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (event.pointerId !== activePointerId) return;
    if (activeStrokeId) {
      onStrokeEnd(activeStrokeId);
    }
    activePointerId = null;
    activeStrokeId = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  // NOTE: not listening to 'pointerleave'. Apple Pencil hover events on
  // iPadOS 14+ can fire spurious leave events during a captured stroke,
  // which would cut the stroke mid-line. setPointerCapture + pointercancel
  // covers all genuine end-of-stroke cases.

  return function detach() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
  };
}

function makePoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    p: typeof event.pressure === 'number' && event.pressure > 0 ? event.pressure : 0.5,
    t: performance.now()
  };
}
