// Worksheet upload: open a native file picker (camera, library, or Files
// for PDFs), save each resulting image into IndexedDB, return one or more
// fresh WorksheetBlocks.
//
// - Image (JPEG / PNG / HEIC): optionally cropped, stored as-is → 1 block.
// - PDF: rendered page-by-page with vendored pdf.js to PNGs in IDB → N
//   blocks (one per page). No crop step — PDF pages are already trimmed.

import { putBlob } from '../db.js';
import { newWorksheetBlock } from '../page-model.js';
import { cropImageFile } from './cropper.js';
import { toast } from '../ui/dialog.js';

// Cap PDF imports so a textbook the kid drags in doesn't lock the app for
// minutes. 25 pages is enough for a homework packet; anything bigger is
// almost certainly the wrong document.
const MAX_PDF_PAGES = 25;

// pdf.js render scale. 1.0 = 72 DPI (PDF default). 2.0 ≈ 144 DPI which is
// crisp on an iPad at full size and still keeps a typical 1-page worksheet
// PNG well under 1 MB.
const PDF_RENDER_SCALE = 2.0;

// Open a native file picker and resolve with the chosen File (or null if cancelled).
// On iPadOS Safari, providing capture="environment" hints the OS toward the camera.
export function pickImageFile({ capture = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Camera-style "capture" only makes sense for images; for the general
    // picker we widen accept to PDFs as well so the kid can grab a homework
    // packet straight from Files.
    input.accept = capture ? 'image/*' : 'image/*,application/pdf';
    if (capture) input.setAttribute('capture', 'environment');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);

    let resolved = false;
    const finish = (file) => {
      if (resolved) return;
      resolved = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    // Some browsers fire 'cancel' when the user dismisses the picker.
    input.addEventListener('cancel', () => finish(null));
    // Safari fallback: when window regains focus and no file was chosen, treat as cancel.
    const onFocus = () => {
      setTimeout(() => {
        if (!resolved) finish(null);
        window.removeEventListener('focus', onFocus);
      }, 300);
    };
    window.addEventListener('focus', onFocus);

    input.click();
  });
}

export function readImageDimensions(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const dims = { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image'));
    };
    img.src = url;
  });
}

function uid() {
  return `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isPdfFile(file) {
  if (!file) return false;
  if (file.type === 'application/pdf') return true;
  // Some pickers report empty type for Files-sourced PDFs; fall back to ext.
  return /\.pdf$/i.test(file.name || '');
}

function isDocxFile(file) {
  if (!file) return false;
  if (file.type ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true;
  return /\.docx?$/i.test(file.name || '');
}

// Lazy-load pdf.js so the ~1.6 MB worker bundle isn't paid for unless the
// kid actually opens a PDF. The vendored worker URL is resolved relative
// to this module so GitHub-Pages subpath deploys (e.g. /mathapp/) still
// find it without a hardcoded base.
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('../../vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        '../../vendor/pdf.worker.min.mjs',
        import.meta.url
      ).href;
      return pdfjs;
    })().catch((err) => {
      // Don't permanently poison the singleton on a one-time failure
      // (e.g. SW cache miss when offline). Persistence QA flagged this:
      // a single load failure used to lock PDF imports out for the
      // whole session. Reset so the next pick can retry.
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

// Render a PDF File into one PNG blob per page and return matching
// WorksheetBlocks. The PNGs are stored under fresh blobIds so they
// participate in the same lifecycle as photo uploads.
async function renderPdfToBlocks(file) {
  let pdfjs;
  try {
    pdfjs = await loadPdfJs();
  } catch (err) {
    console.error('pdf.js failed to load:', err);
    toast('שגיאה בטעינת ספריית ה-PDF — נסי שוב.', { kind: 'error', duration: 4200 });
    return [];
  }
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: buf }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      toast('PDF נעול בסיסמה — לא ניתן לפתוח.', { kind: 'error', duration: 4200 });
    } else {
      console.error('PDF parse failed:', err);
      toast('לא הצלחנו לפתוח את ה-PDF.', { kind: 'error', duration: 4200 });
    }
    return [];
  }

  const totalPages = pdf.numPages;
  const pages = Math.min(totalPages, MAX_PDF_PAGES);
  if (totalPages > MAX_PDF_PAGES) {
    toast(`PDF גדול — מציגים את ${MAX_PDF_PAGES} העמודים הראשונים מתוך ${totalPages}.`, {
      duration: 5000
    });
  }

  const blocks = [];
  for (let i = 1; i <= pages; i += 1) {
    let page = null;
    try {
      page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = document.createElement('canvas');
      // Floor to whole pixels — sub-pixel canvas sizes confuse some Safari
      // builds and add a 1px transparent strip on the bottom-right.
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      );
      if (!blob) continue;
      const blobId = uid();
      await putBlob(blobId, blob);
      blocks.push(newWorksheetBlock({
        blobId,
        naturalWidth: canvas.width,
        naturalHeight: canvas.height
      }));
    } catch (err) {
      // One bad page shouldn't kill the whole import — log and continue so
      // the kid at least gets the readable pages.
      console.warn(`PDF page ${i} render failed:`, err);
    } finally {
      // Release the page's internal cache promptly; multi-page PDFs can
      // pin a lot of memory otherwise.
      if (page && typeof page.cleanup === 'function') page.cleanup();
    }
  }
  try { await pdf.cleanup(); } catch (_) {}
  try { await pdf.destroy(); } catch (_) {}
  return blocks;
}

// Pick a file → optionally crop (images only) → save its blob → return an
// array of new WorksheetBlocks. Image uploads return a single-element
// array; PDF uploads return one block per rendered page. Returns null if
// the user cancelled the picker or the cropper.
export async function uploadWorksheet({
  capture = false,
  fileOverride = null,
  skipCrop = false
} = {}) {
  const picked = fileOverride || (await pickImageFile({ capture }));
  if (!picked) return null;

  if (isDocxFile(picked)) {
    toast('מסמך וורד אינו נתמך — שמרי כ-PDF ונסי שוב.', {
      kind: 'error',
      duration: 5000
    });
    return null;
  }

  if (isPdfFile(picked)) {
    // Tell the kid something is happening — multi-page rendering can take
    // a couple of seconds, and an unresponsive toolbar after a tap looks
    // like the app is broken.
    toast('מייבאים PDF…', { duration: 1800 });
    const blocks = await renderPdfToBlocks(picked);
    if (blocks.length === 0) return null;
    return blocks;
  }

  // Image path. Show the in-app crop UI before storing — let the kid trim
  // down to just the problem he wants to work on. Skip when fileOverride
  // is set (programmatic test path) or when caller explicitly opts out.
  let file = picked;
  if (!skipCrop && !fileOverride) {
    const cropped = await cropImageFile(picked);
    if (cropped === null) return null; // user cancelled the crop
    file = cropped;
  }

  const blobId = uid();
  await putBlob(blobId, file);
  let dims = { naturalWidth: 0, naturalHeight: 0 };
  try {
    dims = await readImageDimensions(file);
  } catch (_) {
    // Non-fatal — we can render without dimensions.
  }
  return [newWorksheetBlock({ blobId, ...dims })];
}
