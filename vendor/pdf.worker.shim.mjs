// Worker entry that loads the Map upsert polyfill BEFORE the pdf.js worker
// bundle evaluates (module import order is evaluation order). Used as
// GlobalWorkerOptions.workerSrc in js/io/import.js — the worker runs in its
// own global, so the main-thread polyfill can't reach it.
import './map-polyfill.mjs';
import './pdf.worker.min.mjs';
