// Pure helpers for detecting text-extracted (lossy) rich-document files and
// naming their plain-text fallback. Loaded both as a browser global (popup) and
// as a CommonJS module (Node tests). Mirrors lib/chat-format.js.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node / tests
  } else {
    root.LOSSY_EXTS = api.LOSSY_EXTS;
    root.isLossyDoc = api.isLossyDoc;
    root.toTxtName = api.toTxtName;
    root.partitionLossy = api.partitionLossy;
    root.getOutputFileName = api.getOutputFileName;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Rich-document formats that Claude stores as extracted text only. Extend
  // here (e.g. "pptx") to widen the set — nothing else needs to change.
  const LOSSY_EXTS = ["docx", "doc", "rtf", "odt"];

  function extOf(fileName) {
    const m = String(fileName || "").match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : "";
  }

  // A doc is lossy when it has text content only (no binary download_url) AND
  // its extension is a rich-document format that was reduced to plain text.
  function isLossyDoc(doc) {
    if (!doc || doc.download_url) return false;
    return LOSSY_EXTS.includes(extOf(doc.file_name));
  }

  // Strip a recognized rich extension and force .txt so the saved file opens
  // cleanly (fixes the "report.docx that is really plain text" corruption).
  function toTxtName(fileName) {
    const name = String(fileName || "untitled");
    const base = name.replace(/\.(docx|doc|rtf|odt)$/i, "");
    return base + ".txt";
  }

  // Split docs into { lossy, safe }, preserving original order within each.
  function partitionLossy(docs) {
    const lossy = [];
    const safe = [];
    (docs || []).forEach((doc) => (isLossyDoc(doc) ? lossy : safe).push(doc));
    return { lossy, safe };
  }

  // Given a doc object and the user-selected format, returns the output filename.
  // Real binary attachments (doc.download_url set) are never renamed to .md —
  // the format dropdown only applies to extracted/generated text content.
  function getOutputFileName(doc, format) {
    const name = (doc && doc.file_name) || "untitled";
    if (format === "markdown" && !(doc && doc.download_url)) {
      // Strip any existing extension and force .md
      return name.replace(/\.(docx|pdf|txt|md)$/i, "") + ".md";
    }
    return name;
  }

  return { LOSSY_EXTS, isLossyDoc, toTxtName, partitionLossy, getOutputFileName };
});
