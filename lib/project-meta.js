// Pure helper that renders a project's metadata (title, description, and the
// Instructions panel) as a Markdown document for the export ZIP. Loaded both as
// a browser global (popup) and as a CommonJS module (Node tests). Mirrors
// lib/format-loss.js.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node / tests
  } else {
    root.buildInstructionsMarkdown = api.buildInstructionsMarkdown;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function trimmed(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // Claude serves timestamps as ISO strings. Render just the date — the exact
  // second is noise in a document a human is going to read.
  function formatDate(value) {
    const raw = trimmed(value);
    if (!raw) return "";
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  /**
   * Render project metadata as Markdown.
   *
   * Returns null when there is nothing worth writing — a project with no
   * description and no instructions should not produce an empty file in the ZIP.
   *
   * @param {{name?:string, description?:string, instructions?:string,
   *          created_at?:string, updated_at?:string}|null} project
   * @returns {string|null}
   */
  function buildInstructionsMarkdown(project) {
    if (!project || typeof project !== "object") return null;

    const description = trimmed(project.description);
    const instructions = trimmed(project.instructions);
    if (!description && !instructions) return null;

    const name = trimmed(project.name) || "Untitled project";
    const created = formatDate(project.created_at);
    const updated = formatDate(project.updated_at);

    const lines = [`# ${name}`, ""];

    const meta = [];
    if (created) meta.push(`Created: ${created}`);
    if (updated) meta.push(`Last updated: ${updated}`);
    if (meta.length > 0) {
      lines.push(`_${meta.join(" · ")}_`, "");
    }

    if (description) {
      lines.push("## Description", "", description, "");
    }

    if (instructions) {
      lines.push("## Instructions", "", instructions, "");
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  return { buildInstructionsMarkdown };
});
