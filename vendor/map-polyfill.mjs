// Polyfill for Map/WeakMap.prototype.getOrInsertComputed / getOrInsert
// (TC39 "upsert" proposal). The vendored pdf.js 5.x calls
// getOrInsertComputed on both the main thread and inside its worker;
// engines older than late-2025 (including current iPadOS Safari) don't
// ship it yet, which made every PDF page render throw and the import
// silently produce nothing. Imported before pdf.min.mjs on the main
// thread and via pdf.worker.shim.mjs inside the worker.
const getOrInsertComputed = function (key, callback) {
  if (this.has(key)) return this.get(key);
  const value = callback(key);
  this.set(key, value);
  return value;
};
const getOrInsert = function (key, defaultValue) {
  if (this.has(key)) return this.get(key);
  this.set(key, defaultValue);
  return defaultValue;
};
// Math.sumPrecise (same era of proposal) — pdf.js uses it in layout paths
// and logs a warning per page without it. Kahan-compensated summation is
// close enough to the spec's full precision for page layout.
if (!Math.sumPrecise) {
  Object.defineProperty(Math, 'sumPrecise', {
    value: function (iterable) {
      let sum = 0;
      let comp = 0;
      for (const v of iterable) {
        const y = v - comp;
        const t = sum + y;
        comp = (t - sum) - y;
        sum = t;
      }
      return sum;
    },
    writable: true,
    configurable: true
  });
}
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      value: getOrInsertComputed,
      writable: true,
      configurable: true
    });
  }
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, 'getOrInsert', {
      value: getOrInsert,
      writable: true,
      configurable: true
    });
  }
}
