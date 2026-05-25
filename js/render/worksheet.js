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
  DEFAULT_ANNOTATION_FONT_CQH
} from '../page-model.js';

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
  } else {
    img.alt = '— תמונת דף לא נמצאה —';
  }

  wrapper.appendChild(img);

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

  if (options.annotateMode) wrapper.classList.add('worksheet--annotate');

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
    annot.text = (el.textContent || '').replace(/\u200B/g, '');
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

  chrome.appendChild(mkBtn('A−', 'הקטנת טקסט', () => {
    annot.fontSize = clampAnnotationFont(
      (annot.fontSize || DEFAULT_ANNOTATION_FONT_CQH) - ANNOTATION_FONT_STEP_CQH
    );
    el.style.fontSize = `${annot.fontSize}cqh`;
    if (options.onAnnotationChanged) options.onAnnotationChanged(block.id);
  }));
  chrome.appendChild(mkBtn('A+', 'הגדלת טקסט', () => {
    annot.fontSize = clampAnnotationFont(
      (annot.fontSize || DEFAULT_ANNOTATION_FONT_CQH) + ANNOTATION_FONT_STEP_CQH
    );
    el.style.fontSize = `${annot.fontSize}cqh`;
    if (options.onAnnotationChanged) options.onAnnotationChanged(block.id);
  }));
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

function bindCreateOnTap(overlay, block, options) {
  if (!options.onCreateAnnotation) return;
  let downX = 0, downY = 0, downTime = 0, pid = null;

  overlay.addEventListener('pointerdown', (e) => {
    if (!overlay.closest('.worksheet').classList.contains('worksheet--annotate')) return;
    // Ignore taps that originate on an existing annotation — those go to
    // edit / long-press, not create.
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
    if (!overlay.closest('.worksheet').classList.contains('worksheet--annotate')) return;
    const dt = performance.now() - downTime;
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    // Treat as a tap only if it was short and didn't move — otherwise the
    // kid was scrolling, and we mustn't drop an annotation under her finger.
    if (dt > 600 || dist > LONGPRESS_SLOP_PX) return;
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    options.onCreateAnnotation(block.id, x, y);
  });
}

// --- helpers --------------------------------------------------------------

function clamp(min, max, v) {
  return Math.min(max, Math.max(min, v));
}
function clamp01(v) {
  return clamp(0, 1, v);
}
