// lib/backup-engine.js — "Back up everything" (Pro, v1.15).
//
// One ZIP holding every project the account can open — its instructions,
// knowledge files, and chat transcripts — plus every chat that sits outside a
// project:
//
//   Claude Backup 2026-10-04/
//     README.md
//     projects/<Project>/instructions.md
//     projects/<Project>/files/…
//     projects/<Project>/chats/<chat>--<id>.md
//     chats/<chat>--<id>.md
//
// Runs in the offscreen document (offscreen/backup.js) so a scheduled backup
// needs no open tab, and from the popup's "Back up now". Everything it touches
// is injected through `deps`, which keeps it testable in Node with a fake
// claude.ai and keeps it free of DOM and chrome.* calls.
//
// It only ever reads what the signed-in account can already open, through the
// same endpoints claude.ai's own pages call.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BackupEngine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ORIGIN = "https://claude.ai";
  const CONCURRENCY = 2;
  const GAP_MS = 200;
  const MAX_PAGES = 200;

  function dateStamp(d) {
    return new Date(d).toISOString().slice(0, 10);
  }

  // A folder name that is safe on every OS and unique within its parent.
  function folderName(name, id, taken) {
    const base =
      String(name || "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "")
        .slice(0, 80) || "Untitled project";
    let out = base;
    if (taken.has(out.toLowerCase())) out = `${base} (${String(id || "").split("-")[0] || taken.size})`;
    taken.add(out.toLowerCase());
    return out;
  }

  /**
   * Page through a claude.ai listing that answers either a bare array or
   * { data, has_more | pagination.has_more }. Stops on an empty page, a page
   * with nothing new (offset ignored), or has_more === false.
   */
  async function fetchAllPages(getJson, urlFor, limit = 100) {
    const all = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(urlFor(limit, offset));
      const rows = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
      if (!rows || rows.length === 0) break;
      let added = 0;
      for (const r of rows) {
        if (!r || !r.uuid || seen.has(r.uuid)) continue;
        seen.add(r.uuid);
        all.push(r);
        added += 1;
      }
      const hasMore = Array.isArray(body)
        ? rows.length > 0
        : body.pagination
          ? body.pagination.has_more === true
          : body.has_more === true;
      if (!hasMore || added === 0) break;
      offset += rows.length;
    }
    return all;
  }

  // Same normalisation content/content.js applies for the popup: text docs carry
  // their content; binary files carry a URL to fetch.
  function normaliseDocs(rows) {
    return (Array.isArray(rows) ? rows : [])
      .filter((d) => d && typeof d === "object")
      .map((d) => ({ file_name: d.file_name || "untitled.md", content: d.content || "", download_url: null }));
  }

  function normaliseFiles(rows, orgId) {
    return (Array.isArray(rows) ? rows : [])
      .map((f) => {
        if (!f || typeof f !== "object") return null;
        let name = f.file_name || "untitled.bin";
        let url = null;
        if (f.document_asset && f.document_asset.url) url = f.document_asset.url;
        else if (f.file_kind === "image" && f.preview_asset && f.preview_asset.url) {
          url = f.preview_asset.url;
          // The preview endpoint serves WebP whatever the original was.
          name = name.replace(/\.(png|jpe?g|gif|bmp|tiff|webp)$/i, ".webp");
        } else if (f.file_kind === "blob" && f.file_uuid) url = `/api/${orgId}/files/${f.file_uuid}/content`;
        return url ? { file_name: name, content: null, download_url: url } : null;
      })
      .filter(Boolean);
  }

  function absolute(url) {
    return /^https?:\/\//i.test(url) ? url : ORIGIN + (url.startsWith("/") ? "" : "/") + url;
  }

  function uniqueIn(name, taken) {
    let out = name;
    let n = 2;
    while (taken.has(out.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      out = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n += 1;
    }
    taken.add(out.toLowerCase());
    return out;
  }

  /**
   * @param {object} deps
   *   getJson(url) → parsed JSON (throws on HTTP error, error.status set)
   *   getBlob(url) → Blob | Uint8Array
   *   zip          → { addFile(name, data) }
   *   format       → { transcriptToMarkdown, transcriptToJson, sanitizeChatFilename,
   *                    buildInstructionsMarkdown, isLossyDoc, toTxtName }
   *   onProgress?  ({ phase, done, total, label })
   *   sleep?       (ms) → Promise
   *   isCancelled? () → boolean
   * @param {object} opts { orgId, projectIds = null, includeLooseChats = true, chatFormat = "markdown", now }
   *   projectIds: null backs up every project; an array backs up only those
   *   (an empty array backs up no projects — useful with includeLooseChats).
   * @returns {Promise<{ folder, stats }>}
   */
  async function runBackup(deps, opts) {
    const { getJson, getBlob, zip, format } = deps;
    const onProgress = deps.onProgress || (() => {});
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const cancelled = deps.isCancelled || (() => false);
    const { orgId, projectIds = null, includeLooseChats = true, chatFormat = "markdown" } = opts;
    const now = opts.now || new Date();
    const ext = chatFormat === "json" ? "json" : "md";
    const folder = `Claude Backup ${dateStamp(now)}`;
    const api = `${ORIGIN}/api/organizations/${orgId}`;
    const stats = { projects: 0, files: 0, chats: 0, looseChats: 0, failedFiles: [], failedChats: [], failedProjects: [] };

    const checkCancel = () => {
      if (cancelled()) {
        const err = new Error("Backup cancelled.");
        err.code = "cancelled";
        throw err;
      }
    };

    // ── 1. Inventory ─────────────────────────────────────────────────────────
    onProgress({ phase: "listing", done: 0, total: 0, label: "Listing projects…" });
    const allProjects = await fetchAllPages(getJson, (l, o) => `${api}/projects?limit=${l}&offset=${o}`);
    const wanted = Array.isArray(projectIds) ? new Set(projectIds) : null;
    const projects = wanted ? allProjects.filter((p) => wanted.has(p.uuid)) : allProjects;
    const taken = new Set();
    const plan = []; // { folder, project, files: [], chats: [] }
    for (const p of projects) {
      checkCancel();
      onProgress({ phase: "listing", done: plan.length, total: projects.length, label: `Listing ${p.name || "project"}…` });
      const entry = { folder: folderName(p.name, p.uuid, taken), project: p, meta: null, files: [], chats: [] };
      const base = `${api}/projects/${p.uuid}`;
      try {
        const [meta, docs, files, chats] = await Promise.all([
          getJson(base).catch(() => null),
          getJson(`${base}/docs`).catch(() => []),
          getJson(`${base}/files`).catch(() => []),
          fetchAllPages(getJson, (l, o) => `${base}/conversations_v2?limit=${l}&offset=${o}`),
        ]);
        entry.meta = meta;
        entry.files = [...normaliseDocs(docs), ...normaliseFiles(files, orgId)];
        entry.chats = chats;
      } catch (err) {
        stats.failedProjects.push(p.name || p.uuid);
      }
      plan.push(entry);
    }

    let loose = [];
    if (includeLooseChats) {
      onProgress({ phase: "listing", done: 0, total: 0, label: "Listing chats…" });
      try {
        const all = await fetchAllPages(getJson, (l, o) => `${api}/chat_conversations_v2?limit=${l}&offset=${o}`);
        loose = all.filter((c) => !c.project_uuid);
      } catch {
        stats.failedChats.push("(could not list chats outside projects)");
      }
    }

    const total =
      plan.reduce((n, e) => n + e.files.length + e.chats.length, 0) + loose.length;
    let done = 0;
    const tick = (label) => onProgress({ phase: "export", done: ++done, total, label });

    // ── 2. Export ────────────────────────────────────────────────────────────
    async function exportChats(list, dir, failedLabel) {
      const names = new Set();
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        checkCancel();
        await Promise.all(
          list.slice(i, i + CONCURRENCY).map(async (c) => {
            const label = c.name || "untitled";
            try {
              const t = await getJson(
                `${api}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
              );
              if (!t.name) t.name = label;
              const body = ext === "json" ? format.transcriptToJson(t) : format.transcriptToMarkdown(t);
              zip.addFile(`${dir}/${uniqueIn(format.sanitizeChatFilename(label, c.uuid, ext), names)}`, body);
            } catch {
              stats.failedChats.push(failedLabel ? `${failedLabel} / ${label}` : label);
            } finally {
              tick(label);
            }
          })
        );
        if (i + CONCURRENCY < list.length) await sleep(GAP_MS);
      }
    }

    for (const entry of plan) {
      checkCancel();
      const dir = `${folder}/projects/${entry.folder}`;
      stats.projects += 1;

      const instructions = format.buildInstructionsMarkdown({
        name: entry.project.name || "",
        description: (entry.meta && entry.meta.description) || entry.project.description || "",
        instructions: (entry.meta && entry.meta.prompt_template) || "",
        created_at: entry.project.created_at || "",
        updated_at: entry.project.updated_at || "",
      });
      if (instructions) zip.addFile(`${dir}/instructions.md`, instructions);

      const fileNames = new Set();
      for (const f of entry.files) {
        checkCancel();
        try {
          if (f.download_url) {
            zip.addFile(`${dir}/files/${uniqueIn(f.file_name, fileNames)}`, await getBlob(absolute(f.download_url)));
          } else if (format.isLossyDoc(f)) {
            // Text Claude extracted from a .docx is not a .docx; naming it one
            // produced files Word refuses to open.
            zip.addFile(`${dir}/files/${uniqueIn(format.toTxtName(f.file_name), fileNames)}`, f.content);
          } else {
            zip.addFile(`${dir}/files/${uniqueIn(f.file_name, fileNames)}`, f.content);
          }
          stats.files += 1;
        } catch {
          stats.failedFiles.push(`${entry.project.name || "project"} / ${f.file_name}`);
        } finally {
          tick(f.file_name);
        }
      }

      const before = stats.failedChats.length;
      await exportChats(entry.chats, `${dir}/chats`, entry.project.name || "project");
      stats.chats += entry.chats.length - (stats.failedChats.length - before);
    }

    if (loose.length) {
      const before = stats.failedChats.length;
      await exportChats(loose, `${folder}/chats`, null);
      stats.looseChats = loose.length - (stats.failedChats.length - before);
    }

    zip.addFile(`${folder}/README.md`, readme(stats, now));
    return { folder, stats };
  }

  function readme(stats, now) {
    const lines = [
      `# Claude backup — ${dateStamp(now)}`,
      "",
      "Made by Claude Project Downloader from your own signed-in Claude account.",
      "",
      `- Projects: ${stats.projects}`,
      `- Project files: ${stats.files}`,
      `- Project chats: ${stats.chats}`,
      `- Chats outside projects: ${stats.looseChats}`,
      "",
      "`projects/<name>/` holds each project's instructions, knowledge files, and chats.",
      "`chats/` holds every chat that is not in a project.",
    ];
    const problems = [
      ["Projects that could not be read", stats.failedProjects],
      ["Files that could not be downloaded", stats.failedFiles],
      ["Chats that could not be exported", stats.failedChats],
    ].filter(([, list]) => list.length);
    for (const [title, list] of problems) {
      lines.push("", `## ${title}`, "", ...list.map((x) => `- ${x}`));
    }
    return lines.join("\n") + "\n";
  }

  return { runBackup, fetchAllPages, folderName, normaliseFiles, dateStamp };
});
