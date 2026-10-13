// lib/context-plan.js — which folders to expand and which rows to tick in
// Claude's Context dialog for a list of project file names (see
// content/context-select.js). Pure, so it is tested without a DOM.
(function (root) {
  "use strict";

  /**
   * @param {string[]} fileNames API file names, possibly with folder paths ("claude/notes.md")
   * @returns {{ folders: string[], labels: string[] }} folders outermost first; row labels (last path part)
   */
  function planSelection(fileNames) {
    const folders = [];
    const labels = [];
    for (const raw of fileNames || []) {
      const parts = String(raw || "").split("/").filter(Boolean);
      if (!parts.length) continue;
      for (const f of parts.slice(0, -1)) if (!folders.includes(f)) folders.push(f);
      const label = parts[parts.length - 1];
      if (!labels.includes(label)) labels.push(label);
    }
    return { folders, labels };
  }

  const api = { planSelection };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ContextSelect = api;
})(typeof window !== "undefined" ? window : globalThis);
