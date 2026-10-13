// popup/context-meter.js — "What's filling this project?" (v1.17).
//
// Claude's own Context panel shows a capacity bar and each file's size in
// bytes. It doesn't show what actually fills the project: tokens. People who
// hit "Project knowledge exceeds maximum. Remove files to continue" have to
// guess which files to drop. This card ranks the files by tokens (the numbers
// Claude's API reports per file), lets the user back up the heavy ones in one
// ZIP, and ticks them in Claude's own Context panel (content/context-select.js).
// We never delete project files ourselves: the user presses Claude's trash
// button, which asks for confirmation.

// Help article for the switch to search mode (RAG) as files near the limit.
export const RAG_HELP_URL =
  "https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects";
// Show the "large project" note from here. The real switch point depends on
// the model's context window (200K–1M), so this is a nudge, not a claim.
export const LARGE_PROJECT_TOKENS = 150000;
const TOP_N = 8;

/** Rough tokens for plain text: ~4 characters per token. */
export function estimateTextTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/**
 * @param {Array<{uuid:string,file_name:string,estimated_token_count:number|null,file_kind?:string,page_count?:number|null,content?:string|null}>} docs
 * @param {string} [instructions] the project's Instructions text
 */
export function summarizeContext(docs, instructions = "") {
  const counted = [];
  let uncounted = 0;
  for (const d of docs || []) {
    let tokens = typeof d.estimated_token_count === "number" ? d.estimated_token_count : null;
    if (tokens == null && typeof d.content === "string" && d.content) tokens = estimateTextTokens(d.content);
    if (tokens == null) uncounted += 1;
    else counted.push({ doc: d, tokens });
  }
  counted.sort((a, b) => b.tokens - a.tokens);
  const fileTokens = counted.reduce((s, x) => s + x.tokens, 0);
  const instructionTokens = estimateTextTokens(instructions);
  const total = fileTokens + instructionTokens;
  const files = counted.map((x) => ({ ...x, share: total ? x.tokens / total : 0 }));
  return {
    total,
    fileTokens,
    instructionTokens,
    files,
    top: files.slice(0, TOP_N),
    rest: files.slice(TOP_N),
    uncounted,
    large: total >= LARGE_PROJECT_TOKENS,
  };
}

export function fmtK(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return String(n);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Render the card into `el`.
 * @param {HTMLElement} el
 * @param {ReturnType<typeof summarizeContext>} s
 * @param {{ onBackup: (docs: object[]) => void, onSelectInClaude: ((docs: object[]) => Promise<string>)|null }} actions
 *   onSelectInClaude resolves to a status line for the card.
 */
export function renderContextMeter(el, s, { onBackup, onSelectInClaude }) {
  if (!el) return;
  if (!s.files.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const row = (x) => {
    const pct = Math.max(1, Math.round(x.share * 100));
    const pages = x.doc.page_count ? ` · ${x.doc.page_count} pages` : "";
    return `<li class="ctx__row">
  <label class="ctx__pick"><input type="checkbox" data-uuid="${esc(x.doc.uuid)}" /><span class="ctx__name" title="${esc(x.doc.file_name)}">${esc(x.doc.file_name)}</span></label>
  <span class="ctx__num">${fmtK(x.tokens)}<span class="ctx__pct">${pct}%</span></span>
  <span class="ctx__bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
  ${pages ? `<span class="ctx__meta">${esc(pages.slice(3))}</span>` : ""}
</li>`;
  };
  const restTokens = s.rest.reduce((n, x) => n + x.tokens, 0);
  el.innerHTML = `
<div class="ctx__head">
  <h2 class="ctx__title">What's filling this project</h2>
  <span class="ctx__total" title="Tokens Claude counts for these files, plus the Instructions">~${fmtK(s.total)} tokens</span>
</div>
<p class="ctx__lead">Claude reads from these in every chat here. Over the limit, or chats feel slow? Trim the biggest first.</p>
<ul class="ctx__list">${s.top.map(row).join("")}</ul>
<p class="ctx__more">${[
    s.rest.length ? `+ ${s.rest.length} smaller file${s.rest.length > 1 ? "s" : ""} (${fmtK(restTokens)})` : "",
    s.instructionTokens ? `Instructions ~${fmtK(s.instructionTokens)}` : "",
    s.uncounted ? `${s.uncounted} image or binary file${s.uncounted > 1 ? "s" : ""} (no count from Claude)` : "",
  ]
    .filter(Boolean)
    .join(" · ")}</p>
${s.large ? `<p class="ctx__note">Large project. As files near the model's context window, paid plans switch to searching them instead of reading them all at once. <a href="${RAG_HELP_URL}" target="_blank" rel="noopener">How Claude handles this ↗</a></p>` : ""}
<div class="ctx__actions">
  <button class="btn btn--secondary btn--small" data-act="ctx-backup" disabled>Back up checked (ZIP)</button>
  ${onSelectInClaude ? `<button class="btn btn--ghost btn--small" data-act="ctx-select" disabled>Remove in Claude…</button>` : ""}
</div>
<p class="ctx__hint" data-role="ctx-hint">Tick files, back them up, then <b>Remove in Claude</b> ticks the same files in Claude's Context panel. You press Claude's delete button; nothing is removed until you do.</p>`;

  const backupBtn = el.querySelector('[data-act="ctx-backup"]');
  const selectBtn = el.querySelector('[data-act="ctx-select"]');
  const hint = el.querySelector('[data-role="ctx-hint"]');
  const checked = () => [...el.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.dataset.uuid);
  // Assigned, not added: the card re-renders on every refresh.
  el.onchange = () => {
    const n = checked().length;
    backupBtn.disabled = n === 0;
    backupBtn.textContent = n ? `Back up ${n} file${n > 1 ? "s" : ""} (ZIP)` : "Back up checked (ZIP)";
    if (selectBtn) selectBtn.disabled = n === 0;
  };
  const picked = () => {
    const ids = new Set(checked());
    return s.files.filter((x) => ids.has(x.doc.uuid)).map((x) => x.doc);
  };
  if (selectBtn) {
    selectBtn.onclick = async () => {
      selectBtn.disabled = true;
      try {
        hint.textContent = await onSelectInClaude(picked());
      } catch (e) {
        hint.textContent = (e && e.message) || "Couldn't reach the Claude tab. Reload it and try again.";
      } finally {
        selectBtn.disabled = checked().length === 0;
      }
    };
  }
  backupBtn.onclick = () => onBackup(picked());
}
