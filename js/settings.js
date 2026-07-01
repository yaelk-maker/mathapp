// App-wide preferences, persisted in localStorage. These are global (not
// per-notebook) toggles the grown-up sets once on the home screen:
//
//   • graphAdvancedTools — show the line (קו) and function (y=mx+b) tools in
//     every coordinate plane (standalone graph block AND on-worksheet graph).
//     Default ON: linear functions (y=mx+b) are core 8th-grade material, so
//     the tools are visible out of the box; a grown-up can hide them from
//     the home-screen settings if they're distracting.
//   • splitMode — open notebooks with the worksheet beside the work area
//     (split screen) instead of stacked. Shared with the in-editor split
//     toggle, which writes the same key.
//
// Keys are namespaced 'mathapp.*' to match the other persisted prefs
// (chromePinned, splitMode) already in the codebase.

const KEYS = {
  graphAdvancedTools: 'mathapp.graphAdvancedTools',
  splitMode: 'mathapp.splitMode'
};

function getBool(key, def = false) {
  const v = localStorage.getItem(key);
  if (v === null) return def;
  return v === '1';
}

function setBool(key, value) {
  localStorage.setItem(key, value ? '1' : '0');
}

export function isGraphAdvancedToolsEnabled() {
  return getBool(KEYS.graphAdvancedTools, true);
}
export function setGraphAdvancedToolsEnabled(value) {
  setBool(KEYS.graphAdvancedTools, value);
}

export function isSplitEnabled() {
  return getBool(KEYS.splitMode, false);
}
export function setSplitEnabled(value) {
  setBool(KEYS.splitMode, value);
}
