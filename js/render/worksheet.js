// Renders a WorksheetBlock as a clean <img> with a transparent annotation
// overlay on top.
// CRITICAL: this block has NO grid background. The grid is only in WorkBlocks.
// That's the whole reason this app exists — uploaded worksheets must render
// crisply, with no gridlines crossing the text.
//
// Annotations are paper-like: no border, no background — only the typed
// glyphs sit on the worksheet. A subtle outline appears when the kid taps
// or long-presses an annotation, so she can find what she typed.

import { getBlob } from '../db.js';
import {
  getAnnotations,
  clampAnnotationFont,
  ANNOTATION_FONT_STEP_CQH,
  DEFAULT_ANNOTATION_FONT_CQH,
  isGridAnnotation,
  isGraphAnnotation
} from '../page-model.js';
import { paintCell } from './grid.js';
import { buildGraphPlane } from './graph.js';

const urlCache = new Map(); // blobId -> objectURL

// Long-press duration. Shorter than the destructive 700ms used on the home
// screen — for "lift to move" the kid expects a quicker response.
const LONGPRESS_MS = 500;
// Movement before pointerup that should disqualify a tap from being treated
// as a long-press (i.e. the kid was actually scrolling).
const LONGPRESS_SLOP_PX = 8;

export async function renderWorksheetBlock(block, options = {}) {
  const wrapper = document.createElement('figure');
  wrapper.className = 'worksheet';
  wrapper.dataset.blockId = block.id;

  const img = document.createElement('img');
  img.className = 'worksheet__image';
  img.alt = '';
  img.draggable = false;

  let url = urlCache.get(block.blobId);
  if (!url) {
    const blob = await getBlob(block.blobId);
    if (blob) {
      url = URL.createObjectURL(blob);
      urlCache.set(block.blobId, url);
    }
  }
  if (url) {
    img.src = url;
    wrapper.appendChild(img);
  } else {
    // Missing blob (e.g. orphaned blobId after a partial restore): a
    // bare <img> with only `alt` set shows nothing on most browsers,
    // so we render an explicit placeholder div instead. Worksheet QA
    // flagged this as a blank-rectangle bug.
    const missing = document.createElement('div');
    missing.className = 'worksheet__image worksheet__image--missing';
    missing.setAttribute('role', 'img');
    missing.setAttribute('aria-label', 'תמונת דף לא נמצאה');
    missing.textContent = '— תמונת דף לא נמצאה —';
    wrapper.appendChild(missing);
  }

  // --- Annotation overlay ---------------------------------------------------
  // Stacks exactly over the image (figure has zero padding, image is the
  // sole child). Using container-type:size lets annotations size their font
  // in cqh units, so text scales naturally with the rendered image.
  const overlay = document.createElement('div');
  overlay.className = 'worksheet__overlay';
  overlay.dataset.blockId = block.id;
  wrapper.appendChild(overlay);

  for (const annot of getAnnotations(block)) {
    overlay.appendChild(buildAnnotationEl(annot, block, options));
  }

  if (options.annotateMode) {
    wrapper.classList.add('worksheet--annotate');
    // The annotate-kind class lets CSS show which mode the kid is in
    // (text vs grid), and lets the create-on-tap binding read it back
    // out without having to thread the kind through every callback.
    wrapper.classList.add(`worksheet--annotate-${options.annotateMode}`);
  }

  // Tap on empty overlay (annotate mode only) creates a new annotation at
  // that spot. We bind on pointerup with a tap heuristic so a drag-to-scroll
  // gesture doesn't spawn stray annotations.
  bindCreateOnTap(overlay, block, options);

  if (options.onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'worksheet__delete';
    del.textContent = '✕';
    del.title = 'הסר דף';
    del.setAttribute('aria-label', 'הסר דף');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onDelete(block.id);
    });
    wrapper.appendChild(del);
  }

  // Tap-to-collapse: in split view, tapping the worksheet shrinks it to a
  // thumbnail so the work block claims the freed space. Tap again to peek
  // back. The class is namespaced on the wrapper itself so split-mode CSS
  // picks it up; in non-split mode the class is harmless (the rules are
  // gated on `.editor--split`).
  wrapper.addEventListener('click', (e) => {
    if (e.target.closest('.worksheet__delete') ||
        e.target.closest('.block__handle') ||
        e.target.closest('.worksheet__overlay')) return;
    wrapper.classList.toggle('worksheet--collapsed');
  });

  return wrapper;
}

// Free object URLs when leaving the editor.
export function revokeWorksheetUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// Free a single blob's URL (call when a worksheet is deleted).
export function revokeBlobUrl(blobId) {
  const url = urlCache.get(blobId);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(blobId);
  }
}

// --- Annotation rendering & interaction ------------------------------------

function buildAnnotationEl(annot, block, options) {
  // Grid annotations render as a small WorkBlock-style grid floating on
  // the worksheet image. Cell layout, cursor styling and tap handling
  // are independent of the contenteditable text-annotation path below.
  if (isGridAnnotation(annot)) {
    return buildGridAnnotationEl(annot, block, options);
  }
  if (isGraphAnnotation(annot)) {
    return buildGraphAnnotationEl(annot, block, options);
  }
  const el = document.createElement('div');
  el.className = 'worksheet__annot';
  el.dataset.annotId = annot.id;
  el.setAttribute('contenteditable', 'plaintext-only');
  // Suppress the iPadOS system keyboard — the kid drives this contenteditable
  // through the in-app math/Hebrew/English keypad instead. Without
  // inputmode="none" Safari pops its own keyboard on focus and the kid sees
  // two keyboards (iOS + app) fighting for the bottom of the screen.
  el.setAttribute('inputmode', 'none');
  el.setAttribute('dir', 'auto');
  // spellcheck off — Hebrew schoolwork mixes digits and math symbols, the
  // red underlines just clutter the worksheet.
  el.setAttribute('spellcheck', 'false');
  el.style.left = `${(annot.x * 100).toFixed(3)}%`;
  el.style.top = `${(annot.y * 100).toFixed(3)}%`;
  el.style.width = `${(annot.w * 100).toFixed(3)}%`;
  el.style.fontSize = `${clampAnnotationFont(annot.fontSize || DEFAULT_ANNOTATION_FONT_CQH)}cqh`;
  // annot.html stores the structured rendering — innerHTML containing our
  // own controlled markup (fraction widgets, etc.). For pure-text
  // annotations (and pre-fraction legacy blocks) we still have annot.text.
  // Setting innerHTML is safe here because the HTML originates from our
  // own writers, not from user-pasted markup (contenteditable is
  // plaintext-only). Whichever field is present wins; falling back to
  // textContent keeps old notebooks rendering correctly.
  if (typeof annot.html === 'string' && annot.html.length > 0) {
    el.innerHTML = annot.html;
  } else {
    el.textContent = annot.text || '';
  }

  bindAnnotationInteractions(el, annot, block, options);
  return el;
}

function bindAnnotationInteractions(el, annot, block, options) {
  // Tracks "has the kid actually put any text in this annotation". An
  // annotation that's only ever been created (a stray tap) and never typed
  // into is cleaned up on blur so the worksheet doesn't accumulate ghost
  // "הקלידי…" placeholders all over the page. Once any character lands,
  // even briefly, the annotation is considered intentional and survives a
  // later empty-blur.
  let everTyped = (annot.text || '').length > 0;
  // Set by the long-press handler right before el.blur(), so the blur
  // listener below knows this isn't an abandoned empty annotation but the
  // gesture-initiated transition into manipulate mode.
  let enteringManipulate = false;

  // ----- tap-only path into manipulate mode -----
  // The long-press is preserved for power users, but a kid with reduced
  // fine-motor control needs a discoverable single-tap alternative.
  // Show a small "⋯" badge above the annotation whenever it gains
  // focus; tap the badge to enter the same manipulate UI that long-
  // press provides (drag to move, resize handle, A−/A+/🗑/✓ chrome).
  //
  // The badge lives in the OVERLAY (sibling of the annotation), not
  // inside the annotation itself — otherwise its "⋯" glyph would leak
  // into el.textContent and be saved as part of annot.text.
  let manipulateBadge = null;
  const removeManipulateBadge = () => {
    if (manipulateBadge) { manipulateBadge.remove(); manipulateBadge = null; }
  };
  el.addEventListener('focus', () => {
    if (el.classList.contains('worksheet__annot--manipulate')) return;
    removeManipulateBadge();
    const overlay = el.closest('.worksheet__overlay');
    if (!overlay) return;
    manipulateBadge = document.createElement('button');
    manipulateBadge.type = 'button';
    manipulateBadge.className = 'worksheet__annot-manipulate-badge';
    manipulateBadge.textContent = '⋯';
    manipulateBadge.title = 'הזיזי / שני גודל / מחקי';
    manipulateBadge.setAttribute('aria-label', 'אפשרויות (הזזה, שינוי גודל, מחיקה)');
    // Position the badge in the overlay using the annotation's stored
    // fractional coordinates. Top is the annotation's top minus an
    // offset for the badge itself (it floats above).
    manipulateBadge.style.left = `${(annot.x * 100).toFixed(3)}%`;
    manipulateBadge.style.top = `calc(${(annot.y * 100).toFixed(3)}% - 50px)`;
    manipulateBadge.addEventListener('mousedown', (e) => e.preventDefault());
    manipulateBadge.addEventListener('pointerdown', (e) => e.stopPropagation());
    manipulateBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      // Order matters: set enteringManipulate BEFORE the blur. el.blur()
      // fires the blur listener synchronously, which checks
      // enteringManipulate to decide whether this is the long-press /
      // badge transition or an abandoned-empty cleanup. With the flag
      // set first, a pristine empty annotation that the kid taps the
      // badge on isn't auto-deleted before manipulate mode opens.
      enteringManipulate = true;
      el.blur();
      removeManipulateBadge();
      enterManipulateMode(el, annot, block, options);
    });
    overlay.appendChild(manipulateBadge);
  }, true);
  el.addEventListener('blur', () => {
    // Delay removal so the badge's own click handler can fire — without
    // this, tapping the badge blurs the annotation first and removes
    // the badge before the click handler runs.
    setTimeout(removeManipulateBadge, 100);
  }, true);

  // ----- text edits -----
  // Input events bubble up from nested editable slots (fraction num/den),
  // so this single listener captures keystrokes regardless of whether the
  // caret is in the root contenteditable or inside a structured composite.
  el.addEventListener('input', () => {
    // Store as html when there's any structured content (fraction widgets
    // etc.), otherwise fall back to plain text. textContent is always
    // populated as a plain-text mirror so legacy code paths and the
    // pristine-empty check stay simple. We strip the ZWSP we sprinkle
    // into empty fraction slots so a brand-new fraction doesn't count
    // as "typed" content.
    // Plain-text mirror. For pure-text annotations this is just
    // textContent with ZWSPs stripped. For annotations that contain
    // fraction widgets, raw textContent runs the num and den slots
    // together (e.g. '12' for 1/2), which loses the fraction's
    // semantics in exports / accessibility readers. We walk the DOM
    // and wrap each fraction as '(num)/(den)'. (Bilingual QA bug.)
    annot.text = serializeAnnotationText(el);
    const hasStructure = el.querySelector('.annot-frac') !== null;
    if (hasStructure) {
      annot.html = el.innerHTML;
    } else if (annot.html !== undefined) {
      // The kid removed the last composite — drop the html field so the
      // annotation is once again a pure-text block.
      delete annot.html;
    }
    // Inserting a structured composite (even with both slots empty)
    // counts as intentional content. Without this, the post-insert
    // input event runs before focus moves into the new fraction's
    // numerator slot — meaning everTyped would still be false at the
    // moment the root annotation blurs, and the cleanup listener would
    // delete the annotation the kid was about to edit.
    if (annot.text.length > 0 || hasStructure) everTyped = true;
    if (options.onAnnotationChanged) options.onAnnotationChanged(block.id);
  });

  // ----- pristine-empty cleanup on blur -----
  // Delete an annotation that was created but never typed in. Skip when
  // we're handing off to manipulate mode (long-press) — that flow blurs
  // the contenteditable on purpose, and the kid hasn't abandoned the
  // annotation, she's just moving it.
  el.addEventListener('blur', () => {
    if (enteringManipulate) { enteringManipulate = false; return; }
    if (everTyped) return;
    if (!options.onDeleteAnnotation) return;
    options.onDeleteAnnotation(block.id, annot.id);
  });

  // ----- long-press to enter manipulate mode -----
  let pressTimer = null;
  let startX = 0, startY = 0;
  let pointerId = null;
  let suppressNextFocus = false;

  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  el.addEventListener('pointerdown', (e) => {
    if (el.classList.contains('worksheet__annot--manipulate')) return;
    // Only react to a single primary pointer — two-finger zoom or a stylus
    // landing alongside a finger must not arm the long-press.
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressNextFocus = true;
      enteringManipulate = true;
      el.blur();
      enterManipulateMode(el, annot, block, options);
    }, LONGPRESS_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONGPRESS_SLOP_PX) {
      cancelPress();
    }
  });
  const endPress = (e) => {
    if (e && e.pointerId !== pointerId) return;
    pointerId = null;
    cancelPress();
  };
  el.addEventListener('pointerup', endPress);
  el.addEventListener('pointercancel', endPress);

  // Block the iOS long-press text-selection menu inside an annotation — our
  // long-press is the move-mode gesture, the system menu would compete.
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  // After a long-press fires, the synthetic click that follows the
  // pointerup would refocus the contenteditable and undo the manipulate
  // mode we just entered. Swallow that one click.
  el.addEventListener('click', (e) => {
    if (suppressNextFocus) {
      suppressNextFocus = false;
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// --- Grid annotation rendering --------------------------------------------
//
// A grid annotation is a small WorkBlock-shaped overlay positioned on the
// worksheet image. Same cell mechanics as the main work area (sparse
// "r,c" -> { ch } map), but stripped down for v1: atoms only, no
// composites, no left margin. The kid taps a cell to focus it; the
// editor.js keypad handlers then route presses into that cell.

function buildGridAnnotationEl(annot, block, options) {
  const el = document.createElement('div');
  el.className = 'worksheet__annot worksheet__annot--grid';
  el.dataset.annotId = annot.id;
  el.dataset.annotType = 'grid';
  // dir="ltr" so digit flow inside cells reads left-to-right even when
  // the surrounding page is RTL — same convention as the main workblock.
  el.setAttribute('dir', 'ltr');
  el.style.left = `${(annot.x * 100).toFixed(3)}%`;
  el.style.top = `${(annot.y * 100).toFixed(3)}%`;
  el.style.width = `${(annot.w * 100).toFixed(3)}%`;

  const grid = document.createElement('div');
  grid.className = 'gridannot__grid';
  grid.style.setProperty('--rows', annot.rows);
  grid.style.setProperty('--cols', annot.cols);

  const focus = options.focusedGridAnnot;
  const isFocused = focus && focus.annotId === annot.id;

  for (let r = 0; r < annot.rows; r += 1) {
    for (let c = 0; c < annot.cols; c += 1) {
      const cellEl = document.createElement('div');
      cellEl.className = 'gridannot__cell';
      cellEl.dataset.r = r;
      cellEl.dataset.c = c;
      const cell = annot.cells && annot.cells[`${r},${c}`];
      const isFocusedCell = isFocused && focus.r === r && focus.c === c;
      // paintCell handles both atom cells ({ ch }) and composites
      // ({ type: 'fraction', num, den }), giving the grid annotation
      // the same fraction rendering the main work area uses.
      paintCell(cellEl, cell, isFocusedCell ? (focus.slot || null) : null);
      if (isFocusedCell) {
        cellEl.classList.add('gridannot__cell--cursor');
      }
      grid.appendChild(cellEl);
    }
  }

  grid.addEventListener('click', (e) => {
    const cellEl = e.target.closest('.gridannot__cell');
    if (!cellEl) return;
    if (options.onGridAnnotCellTap) {
      options.onGridAnnotCellTap(
        block.id,
        annot.id,
        Number(cellEl.dataset.r),
        Number(cellEl.dataset.c)
      );
    }
  });

  el.appendChild(grid);

  // Persistent "⋯" handle at the corner. It's the always-available
  // drag handle for the grid: press and drag → moves the annotation;
  // tap without movement → opens manipulate mode (resize / row+col /
  // delete). The kid's screenshot showed she was trying to drag from
  // the dots directly, so we wire both gestures onto the same button.
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'gridannot__menu';
  menuBtn.textContent = '⋮⋮';
  menuBtn.title = 'גרור כדי להזיז · הקש כדי לפתוח אפשרויות';
  menuBtn.setAttribute('aria-label', 'גרור כדי להזיז, הקש כדי לפתוח אפשרויות');
  menuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  bindAnnotHandle(menuBtn, el, annot, block, options, enterGridManipulateMode);
  el.appendChild(menuBtn);

  bindGridAnnotationInteractions(el, annot, block, options);
  return el;
}

// --- Graph annotation rendering -------------------------------------------
//
// A coordinate-plane floating on the worksheet. The interactive plane itself
// (axes, tap-to-plot points, lines, y=mx+b) is the shared buildGraphPlane from
// graph.js; here we only add the worksheet annotation envelope: position/size,
// a "⋮⋮" handle for drag-or-tap, and a manipulate mode (resize + delete). The
// worksheet image underneath is never touched — the graph's data lives in the
// annotation record.
function buildGraphAnnotationEl(annot, block, options) {
  const el = document.createElement('div');
  el.className = 'worksheet__annot worksheet__annot--graph';
  el.dataset.annotId = annot.id;
  el.dataset.annotType = 'graph';
  el.setAttribute('dir', 'ltr');
  el.style.left = `${(annot.x * 100).toFixed(3)}%`;
  el.style.top = `${(annot.y * 100).toFixed(3)}%`;
  el.style.width = `${(annot.w * 100).toFixed(3)}%`;

  const plane = buildGraphPlane(annot, {
    // Reuse the annotation undo/save callbacks: manipulate-start pushes undo,
    // changed queues a save — same contract the text/grid annotations use.
    onEditStart: () => {
      if (options.onAnnotationManipulateStart) options.onAnnotationManipulateStart(block.id, annot.id);
    },
    onChange: () => {
      if (options.onAnnotationChanged) options.onAnnotationChanged(block.id);
    }
  });
  el.appendChild(plane);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'gridannot__menu';
  menuBtn.textContent = '⋮⋮';
  menuBtn.title = 'גרור כדי להזיז · הקש כדי לפתוח אפשרויות';
  menuBtn.setAttribute('aria-label', 'גרור כדי להזיז, הקש כדי לפתוח אפשרויות');
  menuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  bindAnnotHandle(menuBtn, el, annot, block, options, enterGraphManipulateMode);
  el.appendChild(menuBtn);

  return el;
}

// Manipulate mode for a graph annotation: a resize handle plus a minimal
// delete/done chrome. Dragging is handled by the "⋮⋮" handle (not the body,
// which is the plotting surface), so we don't bind body-drag here.
function enterGraphManipulateMode(el, annot, block, options) {
  if (el.classList.contains('worksheet__annot--manipulate')) return;
  el.classList.add('worksheet__annot--manipulate');
  if (options.onAnnotationManipulateStart) {
    options.onAnnotationManipulateStart(block.id, annot.id);
  }

  const overlay = el.closest('.worksheet__overlay');
  const chrome = document.createElement('div');
  chrome.className = 'worksheet__annot-chrome';
  const mkBtn = (label, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'worksheet__annot-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  chrome.appendChild(mkBtn('🗑', 'מחיקה', () => {
    if (options.onDeleteAnnotation) options.onDeleteAnnotation(block.id, annot.id);
  }));
  chrome.appendChild(mkBtn('✓', 'סיום', () => exitManipulateMode()));
  el.appendChild(chrome);

  const rect = el.getBoundingClientRect();
  if (rect.top < 60) chrome.classList.add('worksheet__annot-chrome--flip-below');

  const handle = document.createElement('div');
  handle.className = 'worksheet__annot-resize';
  handle.setAttribute('aria-hidden', 'true');
  el.appendChild(handle);
  bindResize(handle, el, annot, block, overlay, options);

  function exitManipulateMode() {
    el.classList.remove('worksheet__annot--manipulate');
    chrome.remove();
    handle.remove();
    document.removeEventListener('pointerdown', onOutside, true);
  }
  const onOutside = (e) => {
    if (el.contains(e.target)) return;
    exitManipulateMode();
  };
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

// Drag-or-tap binding on the corner "⋮⋮" handle.
//   - pointerdown starts a tentative drag.
//   - pointermove > slop threshold → committed drag, update annot.x/y
//     and reposition the wrapper inline as the kid moves.
//   - pointerup with no drift → tap, open manipulate mode.
//   - pointerup after a drag → persist and fire onAnnotationChanged.
// We don't enter manipulate mode for drags — the kid is just
// repositioning, no reason to also flip them into resize mode.
// `openManipulate(el, annot, block, options)` is invoked on a tap (no drift),
// letting grid and graph annotations open their own manipulate chrome.
function bindAnnotHandle(handleEl, el, annot, block, options, openManipulate) {
  let pointerId = null;
  let startClientX = 0, startClientY = 0;
  let startAnnotX = 0, startAnnotY = 0;
  let moved = false;
  const SLOP = 5;

  handleEl.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    startClientX = e.clientX;
    startClientY = e.clientY;
    startAnnotX = annot.x;
    startAnnotY = annot.y;
    moved = false;
    try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}
    e.stopPropagation();
  });

  handleEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startClientX;
    const dy = e.clientY - startClientY;
    if (!moved && Math.hypot(dx, dy) < SLOP) return;
    moved = true;
    const overlay = el.closest('.worksheet__overlay');
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    annot.x = clamp01(startAnnotX + dx / rect.width);
    annot.y = clamp01(startAnnotY + dy / rect.height);
    el.style.left = `${(annot.x * 100).toFixed(3)}%`;
    el.style.top = `${(annot.y * 100).toFixed(3)}%`;
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    try { handleEl.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved) {
      // Push an undo snapshot at the END of the drag (cheap once-per-
      // gesture instead of every move) and persist the new position.
      if (options.onAnnotationManipulateStart) {
        options.onAnnotationManipulateStart(block.id, annot.id);
      }
      if (options.onAnnotationChanged) {
        options.onAnnotationChanged(block.id);
      }
    }
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);

  // Click fires after pointerup. If the kid didn't drag (moved=false),
  // treat it as a tap that opens manipulate mode. If they dragged,
  // swallow the click so manipulate mode doesn't pop up at the end of
  // every drag.
  handleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moved) {
      moved = false;
      return;
    }
    openManipulate(el, annot, block, options);
  });
}

function bindGridAnnotationInteractions(el, annot, block, options) {
  // Long-press anywhere on the grid wrapper (but NOT on a cell — cell
  // taps focus the cell for typing) enters manipulate mode. The
  // persistent "⋯" button is the primary path; long-press remains as
  // a power-user shortcut for kids who'd rather press-and-hold than
  // aim at the corner button.
  let pressTimer = null;
  let startX = 0, startY = 0;
  let pointerId = null;

  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  el.addEventListener('pointerdown', (e) => {
    if (el.classList.contains('worksheet__annot--manipulate')) return;
    if (pointerId !== null) return;
    // A press that starts on a cell is a tap-to-focus, not a manipulate
    // gesture. The cell's click handler will fire on pointerup.
    if (e.target.closest('.gridannot__cell')) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      enterGridManipulateMode(el, annot, block, options);
    }, LONGPRESS_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONGPRESS_SLOP_PX) {
      cancelPress();
    }
  });
  const endPress = (e) => {
    if (e && e.pointerId !== pointerId) return;
    pointerId = null;
    cancelPress();
  };
  el.addEventListener('pointerup', endPress);
  el.addEventListener('pointercancel', endPress);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function enterGridManipulateMode(el, annot, block, options) {
  if (el.classList.contains('worksheet__annot--manipulate')) return;
  el.classList.add('worksheet__annot--manipulate');

  if (options.onAnnotationManipulateStart) {
    options.onAnnotationManipulateStart(block.id, annot.id);
  }

  const overlay = el.closest('.worksheet__overlay');
  const chrome = buildGridManipulateChrome(el, annot, block, options, exitManipulateMode);
  el.appendChild(chrome);

  // Flip chrome below the grid when there isn't enough room above.
  const rect = el.getBoundingClientRect();
  const CHROME_HEIGHT_PX = 60;
  if (rect.top < CHROME_HEIGHT_PX) {
    chrome.classList.add('worksheet__annot-chrome--flip-below');
  }

  const handle = document.createElement('div');
  handle.className = 'worksheet__annot-resize';
  handle.setAttribute('aria-hidden', 'true');
  el.appendChild(handle);

  bindDrag(el, annot, block, overlay, options);
  bindResize(handle, el, annot, block, overlay, options);

  function exitManipulateMode() {
    el.classList.remove('worksheet__annot--manipulate');
    chrome.remove();
    handle.remove();
    document.removeEventListener('pointerdown', onOutside, true);
  }
  const onOutside = (e) => {
    if (el.contains(e.target)) return;
    exitManipulateMode();
  };
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

function buildGridManipulateChrome(el, annot, block, options, exit) {
  const chrome = document.createElement('div');
  chrome.className = 'worksheet__annot-chrome';

  const mkBtn = (label, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'worksheet__annot-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  // Per-grid row/column adjustment. We re-render the whole worksheet
  // via onAnnotationChanged + a save — cheap because grids are small
  // and the kid is in manipulate mode, not mid-typing.
  const changeShape = (drow, dcol) => {
    const newRows = Math.max(1, Math.min(12, annot.rows + drow));
    const newCols = Math.max(2, Math.min(20, annot.cols + dcol));
    if (newRows === annot.rows && newCols === annot.cols) return;
    // Drop any cells that no longer fit so the data doesn't grow stale.
    if (newRows < annot.rows || newCols < annot.cols) {
      const kept = {};
      for (const [k, cell] of Object.entries(annot.cells || {})) {
        const [r, c] = k.split(',').map(Number);
        if (r < newRows && c < newCols) kept[k] = cell;
      }
      annot.cells = kept;
    }
    annot.rows = newRows;
    annot.cols = newCols;
    if (options.onAnnotationChanged) options.onAnnotationChanged(block.id);
  };

  chrome.appendChild(mkBtn('+שורה', 'הוספת שורה', () => changeShape(+1, 0)));
  chrome.appendChild(mkBtn('−שורה', 'מחיקת שורה', () => changeShape(-1, 0)));
  chrome.appendChild(mkBtn('+עמודה', 'הוספת עמודה', () => changeShape(0, +1)));
  chrome.appendChild(mkBtn('−עמודה', 'מחיקת עמודה', () => changeShape(0, -1)));
  chrome.appendChild(mkBtn('🗑', 'מחיקה', () => {
    if (options.onDeleteAnnotation) options.onDeleteAnnotation(block.id, annot.id);
  }));
  chrome.appendChild(mkBtn('✓', 'סיום', () => exit()));
  return chrome;
}

// --- Manipulate mode (move / resize / font / delete) ----------------------

function enterManipulateMode(el, annot, block, options) {
  if (el.classList.contains('worksheet__annot--manipulate')) return;
  el.classList.add('worksheet__annot--manipulate');
  el.setAttribute('contenteditable', 'false');

  if (options.onAnnotationManipulateStart) {
    options.onAnnotationManipulateStart(block.id, annot.id);
  }

  const overlay = el.closest('.worksheet__overlay');
  const chrome = buildManipulateChrome(el, annot, block, options, exitManipulateMode);
  el.appendChild(chrome);

  // Flip chrome below the annotation when there isn't enough room
  // above. The chrome is ~56px tall (44px button + padding); if the
  // annotation's top is within that distance of the viewport top, the
  // chrome would render off-screen. Accessibility audit flagged this
  // as a discoverability issue for annotations near the top of a
  // worksheet — the kid couldn't reach the A−/A+/🗑/✓ controls.
  const annotRect = el.getBoundingClientRect();
  const CHROME_HEIGHT_PX = 60;
  if (annotRect.top < CHROME_HEIGHT_PX) {
    chrome.classList.add('worksheet__annot-chrome--flip-below');
  }

  const handle = document.createElement('div');
  handle.className = 'worksheet__annot-resize';
  handle.setAttribute('aria-hidden', 'true');
  el.appendChild(handle);

  bindDrag(el, annot, block, overlay, options);
  bindResize(handle, el, annot, block, overlay, options);

  function exitManipulateMode() {
    el.classList.remove('worksheet__annot--manipulate');
    el.setAttribute('contenteditable', 'plaintext-only');
    chrome.remove();
    handle.remove();
    document.removeEventListener('pointerdown', onOutside, true);
  }

  // Tapping outside the annotation exits manipulate mode. Capture phase so
  // we see the event before any handlers stop propagation.
  const onOutside = (e) => {
    if (el.contains(e.target)) return;
    exitManipulateMode();
  };
  // Defer registration to the next tick so the pointerup that triggered the
  // long-press doesn't immediately match this listener.
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

function buildManipulateChrome(el, annot, block, options, exit) {
  const chrome = document.createElement('div');
  chrome.className = 'worksheet__annot-chrome';
  chrome.setAttribute('contenteditable', 'false');

  const mkBtn = (label, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'worksheet__annot-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  // A−/A+ skip the dirty-write when the new clamped size equals the
  // current one (i.e. the kid is at the min/max boundary). Without
  // this, every press at the limit still queued a save for an
  // unchanged value. (Annotations QA.)
  const stepFont = (delta) => {
    const current = annot.fontSize || DEFAULT_ANNOTATION_FONT_CQH;
    const next = clampAnnotationFont(current + delta);
    if (next === current) {
      // Flash the button briefly so the kid sees the press registered
      // but the limit was hit. CSS animation already exists for the
      // longpress-fired flash; reuse the same class.
      return false;
    }
    annot.fontSize = next;
    el.style.fontSize = `${annot.fontSize}cqh`;
    if (options.onAnnotationChanged) options.onAnnotationChanged(block.id);
    return true;
  };
  chrome.appendChild(mkBtn('A−', 'הקטנת טקסט', () => stepFont(-ANNOTATION_FONT_STEP_CQH)));
  chrome.appendChild(mkBtn('A+', 'הגדלת טקסט', () => stepFont(+ANNOTATION_FONT_STEP_CQH)));
  chrome.appendChild(mkBtn('🗑', 'מחיקה', () => {
    if (options.onDeleteAnnotation) {
      options.onDeleteAnnotation(block.id, annot.id);
    }
  }));
  chrome.appendChild(mkBtn('✓', 'סיום', () => exit()));
  return chrome;
}

function bindDrag(el, annot, block, overlay, options) {
  let startClientX = 0, startClientY = 0;
  let startX = 0, startY = 0;
  let pointerId = null;
  let moved = false;

  el.addEventListener('pointerdown', (e) => {
    // Only drag from the annotation body, not the chrome buttons or resize
    // handle (each handles its own pointerdown).
    if (e.target.closest('.worksheet__annot-chrome') ||
        e.target.closest('.worksheet__annot-resize')) return;
    if (!el.classList.contains('worksheet__annot--manipulate')) return;
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    startClientX = e.clientX;
    startClientY = e.clientY;
    startX = annot.x;
    startY = annot.y;
    moved = false;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = (e.clientX - startClientX) / rect.width;
    const dy = (e.clientY - startClientY) / rect.height;
    if (!moved && Math.hypot(e.clientX - startClientX, e.clientY - startClientY) < 2) return;
    moved = true;
    annot.x = clamp01(startX + dx);
    annot.y = clamp01(startY + dy);
    el.style.left = `${(annot.x * 100).toFixed(3)}%`;
    el.style.top = `${(annot.y * 100).toFixed(3)}%`;
  });
  const endDrag = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved && options.onAnnotationChanged) {
      options.onAnnotationChanged(block.id);
    }
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

function bindResize(handle, el, annot, block, overlay, options) {
  let startClientX = 0;
  let startW = 0;
  let startX = 0;
  let pointerId = null;
  let moved = false;

  handle.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    startClientX = e.clientX;
    startW = annot.w;
    startX = annot.x;
    moved = false;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    e.stopPropagation();
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0) return;
    const dx = (e.clientX - startClientX) / rect.width;
    moved = true;
    annot.w = clamp(0.04, 1 - startX, startW + dx);
    el.style.width = `${(annot.w * 100).toFixed(3)}%`;
  });
  const endResize = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved && options.onAnnotationChanged) {
      options.onAnnotationChanged(block.id);
    }
  };
  handle.addEventListener('pointerup', endResize);
  handle.addEventListener('pointercancel', endResize);
}

// --- Creating annotations by tapping the overlay --------------------------
//
// Both box kinds (calculation grid and free text) share ONE creation
// method: the kid arms a kind via the toolbar button, then a SINGLE
// deliberate tap on the worksheet drops one box where she tapped. The
// editor disarms the mode the instant a box lands (see createAnnotation),
// so the overlay only listens for that one placement tap — brushing the
// page when nothing is armed can't spawn a box, and a second tap after
// placement doesn't either. That replaces the old split where grids
// created on every single tap (too sensitive) and text needed a fiddly
// double-tap (too hard); the two are now identical.

function bindCreateOnTap(overlay, block, options) {
  if (!options.onCreateAnnotation) return;

  // Read the armed kind off the worksheet element. The editor sets
  // `worksheet--annotate-grid` / `worksheet--annotate-text` while a kind
  // is armed; the bare `worksheet--annotate` class is the "armed" gate.
  const currentAnnotateKind = () => {
    const ws = overlay.closest('.worksheet');
    if (!ws) return null;
    if (ws.classList.contains('worksheet--annotate-grid')) return 'grid';
    if (ws.classList.contains('worksheet--annotate-text')) return 'text';
    if (ws.classList.contains('worksheet--annotate-graph')) return 'graph';
    return null;
  };

  // pointerdown/up tracking for tap detection
  let downX = 0, downY = 0, downTime = 0, pid = null;

  overlay.addEventListener('pointerdown', (e) => {
    if (!currentAnnotateKind()) return;
    if (e.target.closest('.worksheet__annot')) return;
    pid = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
    downTime = performance.now();
  });

  overlay.addEventListener('pointerup', (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (e.target.closest('.worksheet__annot')) return;
    const kind = currentAnnotateKind();
    if (!kind) return;
    const dt = performance.now() - downTime;
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    // Tap heuristic: short hold, no drift — a scroll/drag must not place a
    // box even while armed.
    if (dt > 600 || dist > LONGPRESS_SLOP_PX) return;

    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const xFrac = clamp01((e.clientX - rect.left) / rect.width);
    const yFrac = clamp01((e.clientY - rect.top) / rect.height);
    options.onCreateAnnotation(block.id, xFrac, yFrac, kind);
  });
}

// --- helpers --------------------------------------------------------------

function clamp(min, max, v) {
  return Math.min(max, Math.max(min, v));
}
function clamp01(v) {
  return clamp(0, 1, v);
}

// Walk an annotation's DOM and produce a plain-text mirror that
// preserves fraction semantics. textContent on the contenteditable
// would emit "12" for a stacked 1/2, losing the slash. We emit
// "(num)/(den)" for each fraction widget (parens only when needed).
// (Bilingual QA bug.)
function serializeAnnotationText(root) {
  const strip = (s) => (s || '').replace(/​/g, '');
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += strip(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    if (node.classList && node.classList.contains('annot-frac')) {
      const num = node.querySelector('.annot-frac-num');
      const den = node.querySelector('.annot-frac-den');
      const numText = strip(num ? num.textContent : '');
      const denText = strip(den ? den.textContent : '');
      // Parenthesize only when ambiguous: single digit or simple
      // decimal stays bare ("1/2"), anything else gets parens
      // ("(x+1)/(2y)"). Empty slot prints as "()" so the structure
      // round-trips visibly.
      const wrap = (t) => (/^-?\d+(\.\d+)?$/.test(t) ? t : `(${t})`);
      out += `${numText ? wrap(numText) : '()'}/${denText ? wrap(denText) : '()'}`;
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}
