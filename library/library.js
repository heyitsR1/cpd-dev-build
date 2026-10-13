// library.js — the v1.16 Library: every chat in the signed-in Claude account,
// with folders, full-text search, and bulk move / export / delete.
//
// Reads (the chat list, projects, transcripts for the index and exports) are
// plain GETs from this extension page with the browser's claude.ai cookies, as
// the backup and usage card already do. Writes — delete and move — run inside
// an open claude.ai tab through chrome.scripting, so they leave from claude.ai's
// own origin exactly like its Recents page's bulk actions do.
//
// Free plan: 3 folders, the top 5 search matches, bulk actions on 5 chats at a
// time (exports also count against the 5-a-day download allowance). Pro: no
// limits. Every limit is met in place, with the user's selection intact.

import { checkLicense, getUpgradeUrl, getRemainingDownloads, recordDownload } from "../popup/licensing.js";
import { openIndex } from "./search-store.js";
import { icon } from "./icons.js";
import { initReport, noteError } from "../lib/report.js";

const F = window.CpdFolders;
const S = window.CpdSearch;
const B = window.CpdBulk;
const U = window.ClaudeUsage;
const ORIGIN = "https://claude.ai";
const PAGE_ROWS = 150;
const INDEX_CONCURRENCY = 2;
const INDEX_GAP_MS = 150;
const SIDEBAR_KEY = "sidebarFolders";

const $ = (id) => document.getElementById(id);

const st = {
  isPro: false,
  orgId: null,
  loading: true,
  error: null, // "signed_out" | "network"
  chats: [], // listing rows, newest first
  chatById: new Map(),
  projects: new Map(), // uuid → { uuid, name }
  folders: F.emptyState(),
  filter: "all", // "all" | "unfiled" | folder id
  query: "",
  results: null, // search results for the current query, or null
  rows: [], // what the list shows now
  shown: PAGE_ROWS,
  selected: new Set(),
  anchor: null, // last clicked row, for shift-click ranges
  panel: null, // bulk-bar panel: "folder" | "project" | "delete" | "limit" | "progress"
  busy: false,
  index: { done: 0, total: 0, running: false, failed: 0, error: null },
  docs: new Map(), // uuid → prepared search doc
  folderEdit: null, // "new" | "rename" | "delete"
  limitCard: null, // "folders"
};

// ── Text ────────────────────────────────────────────────────────────────────

function t(key, fallback, subs) {
  const list = subs == null ? undefined : [].concat(subs).map(String);
  if (window.i18n) return window.i18n.t(key, list, fallback);
  return (list || []).reduce((out, v, i) => out.replace(`$${i + 1}`, v), fallback);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const fmtNum = (n) => Number(n || 0).toLocaleString();

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toISOString().slice(0, 10);
}

// ── claude.ai ───────────────────────────────────────────────────────────────

async function getJson(url, tries = 2) {
  const res = await fetch(url, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 429 && tries > 0) {
    await sleep(2000);
    return getJson(url, tries - 1);
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveOrg() {
  const { lastOrgId } = await chrome.storage.local.get("lastOrgId");
  const orgs = await getJson(`${ORIGIN}/api/organizations`);
  const id = U.pickOrg(orgs, lastOrgId);
  if (id && id !== lastOrgId) chrome.storage.local.set({ lastOrgId: id });
  return id;
}

// Page through a listing that answers { data, has_more } or a bare array.
async function fetchAll(urlFor) {
  const all = [];
  const seen = new Set();
  for (let offset = 0, page = 0; page < 200; page += 1) {
    const body = await getJson(urlFor(100, offset));
    const rows = Array.isArray(body) ? body : (body && body.data) || [];
    let added = 0;
    for (const r of rows) {
      if (r && r.uuid && !seen.has(r.uuid)) {
        seen.add(r.uuid);
        all.push(r);
        added += 1;
      }
    }
    const more = Array.isArray(body) ? rows.length >= 100 : body && (body.has_more === true || (body.pagination && body.pagination.has_more === true));
    if (!more || !added) break;
    offset += rows.length;
  }
  return all;
}

const transcriptUrl = (uuid) =>
  `${ORIGIN}/api/organizations/${st.orgId}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`;

/** POST from inside an open claude.ai tab, so the request carries claude.ai's own origin. */
async function postFromClaudeTab(url, body) {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  const tab = tabs.find((x) => !x.discarded) || null;
  if (!tab) throw Object.assign(new Error("no claude.ai tab"), { code: "no_tab" });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (u, b) => {
      try {
        const r = await fetch(u, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(b),
        });
        let json = null;
        try {
          json = await r.json();
        } catch {
          /* empty body */
        }
        return { ok: r.ok, status: r.status, json };
      } catch (e) {
        return { ok: false, status: 0, json: null };
      }
    },
    args: [url, body],
  });
  const out = res && res.result;
  if (!out || !out.ok) throw Object.assign(new Error(`HTTP ${out ? out.status : 0}`), { status: out && out.status });
  return out.json;
}

// ── Storage ─────────────────────────────────────────────────────────────────

async function loadFolders() {
  const data = await chrome.storage.local.get(F.FOLDERS_KEY);
  st.folders = F.normalize(data[F.FOLDERS_KEY]);
  if (st.filter !== "all" && st.filter !== "unfiled" && !st.folders.folders.some((f) => f.id === st.filter)) st.filter = "all";
}

async function saveFolders(next) {
  st.folders = F.normalize(next);
  await chrome.storage.local.set({ [F.FOLDERS_KEY]: st.folders });
}

// ── Upgrade ─────────────────────────────────────────────────────────────────

function openUpgrade(hit) {
  chrome.tabs.create({ url: getUpgradeUrl(hit) });
}

// ── Rows ────────────────────────────────────────────────────────────────────

// st.folders is always normalized, so read it directly: F.folderOf normalizes
// on every call, which is too slow per row on a large account.
function chatFolder(uuid) {
  const it = st.folders.items[F.itemKey("chat", uuid)];
  return it ? it.folderId : null;
}

function folderName(id) {
  const f = st.folders.folders.find((x) => x.id === id);
  return f ? f.name : "";
}

function computeRows() {
  const inFilter = (uuid) => {
    if (st.filter === "all") return true;
    const fid = chatFolder(uuid);
    return st.filter === "unfiled" ? !fid : fid === st.filter;
  };

  if (st.query.trim()) {
    const results = S.search([...st.docs.values()], st.query).filter((r) => inFilter(r.uuid));
    st.results = results;
    const { shown, locked } = S.visibleResults(results, st.isPro);
    st.locked = locked;
    return shown.map((r) => ({ kind: "chat", uuid: r.uuid, name: r.name, updated_at: r.updated_at, project_uuid: r.project_uuid, snippet: r.snippet }));
  }
  st.results = null;
  st.locked = 0;

  if (st.filter !== "all" && st.filter !== "unfiled") {
    // A folder: its projects first, then its chats, newest first.
    const items = F.itemsIn(st.folders, st.filter);
    const projects = items
      .filter((i) => i.kind === "project")
      .map((i) => ({ kind: "project", uuid: i.uuid, name: (st.projects.get(i.uuid) || {}).name || i.name }));
    const chats = items
      .filter((i) => i.kind === "chat")
      .map((i) => {
        const c = st.chatById.get(i.uuid);
        return { kind: "chat", uuid: i.uuid, name: (c && c.name) || i.name, updated_at: c && c.updated_at, project_uuid: c && c.project_uuid };
      })
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return [...projects, ...chats];
  }
  return st.chats.filter((c) => inFilter(c.uuid)).map((c) => ({ kind: "chat", uuid: c.uuid, name: c.name, updated_at: c.updated_at, project_uuid: c.project_uuid }));
}

function selectableRows() {
  return st.rows.filter((r) => r.kind === "chat");
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  st.rows = st.loading || st.error ? [] : computeRows();
  // Drop selections that are no longer on screen (filter or search changed).
  const visible = new Set(selectableRows().map((r) => r.uuid));
  for (const u of [...st.selected]) if (!visible.has(u)) st.selected.delete(u);
  renderIndexLine();
  renderFolders();
  renderList();
  renderBulk();
}

function renderIndexLine() {
  const ix = st.index;
  const el = $("indexText");
  const sync = $("indexSyncBtn");
  sync.hidden = true;
  if (st.loading || st.error) {
    el.textContent = "";
    return;
  }
  if (ix.error === "signed_out") {
    el.innerHTML = `${icon("circle-alert", { size: 12 })} ${esc(t("libIndexSignedOut", "Search paused: sign in to claude.ai."))}`;
    return;
  }
  if (ix.running) {
    el.innerHTML = `<span class="spin">${icon("refresh", { size: 12 })}</span> ${esc(
      t("libIndexing", "Indexing $1 / $2 chats for search", [fmtNum(ix.done), fmtNum(ix.total)])
    )}`;
    return;
  }
  el.textContent = t("libIndexed", "$1 chats · searched on this computer", fmtNum(st.chats.length));
  if (ix.failed) {
    el.textContent += " · " + t("libIndexFailed", "$1 not indexed", fmtNum(ix.failed));
    sync.hidden = false;
  }
}

function renderFolders() {
  const bar = $("folderBar");
  // No counts to show until the chat list is in; "All chats 0" would be a lie.
  bar.hidden = st.loading || !!st.error;
  $("folderTools").hidden = bar.hidden;
  if (bar.hidden) return;
  const counts = F.counts(st.folders);
  const filed = new Set(Object.values(st.folders.items).filter((i) => i.kind === "chat").map((i) => i.uuid));
  const unfiled = st.chats.filter((c) => !filed.has(c.uuid)).length;
  const chip = (id, name, n, extra = "") =>
    `<button class="chip" role="tab" data-filter="${esc(id)}" aria-selected="${st.filter === id}" ${extra}>` +
    `<span class="chip__name">${esc(name)}</span>${n == null ? "" : `<span class="chip__n">${fmtNum(n)}</span>`}</button>`;
  let html =
    chip("all", t("libFolderAll", "All chats"), st.chats.length) +
    chip("unfiled", t("libFolderUnfiled", "Unfiled"), unfiled);
  for (const f of st.folders.folders) {
    html += chip(f.id, f.name, counts[f.id], `data-folder="${esc(f.id)}"`).replace(
      `<span class="chip__name">`,
      `${icon("folder", { size: 14 })}<span class="chip__name">`
    );
  }
  if (st.folderEdit === "new") {
    html += `<input class="chip-input" id="newFolderInput" maxlength="60" placeholder="${esc(t("libFolderNamePh", "Folder name"))}" aria-label="${esc(t("libFolderNamePh", "Folder name"))}" />`;
  } else {
    html += `<button class="chip chip--add" id="newFolderBtn" title="${esc(t("libNewFolderTip", "New folder (N)"))}">${icon("folder-plus", { size: 14 })}<span>${esc(t("libNewFolder", "New folder"))}</span></button>`;
  }
  bar.innerHTML = html;
  const input = $("newFolderInput");
  if (input) input.focus();

  // The selected folder's tools: rename, delete.
  const tools = $("folderTools");
  const f = st.folders.folders.find((x) => x.id === st.filter);
  tools.hidden = !f;
  if (f) {
    if (st.folderEdit === "rename") {
      tools.innerHTML = `<input class="chip-input" id="renameFolderInput" maxlength="60" value="${esc(f.name)}" aria-label="${esc(t("libFolderNamePh", "Folder name"))}" />`;
      const r = $("renameFolderInput");
      r.focus();
      r.select();
    } else if (st.folderEdit === "delete") {
      tools.innerHTML =
        `<span>${esc(t("libDeleteFolderQ", "Delete folder “$1”? Its chats stay in Claude.", f.name))}</span>` +
        `<span class="folder-tools__spacer"></span>` +
        `<button class="btn btn--sm" data-act="folder-cancel">${esc(t("libCancel", "Cancel"))}</button>` +
        `<button class="btn btn--sm btn--danger-solid" data-act="folder-delete-yes">${esc(t("libDeleteFolder", "Delete folder"))}</button>`;
    } else {
      tools.innerHTML =
        `<span class="folder-tools__name">${esc(f.name)}</span>` +
        `<span class="folder-tools__spacer"></span>` +
        `<button class="link-btn" data-act="folder-rename">${icon("pencil", { size: 12 })}${esc(t("libRename", "Rename"))}</button>` +
        `<button class="link-btn link-btn--danger" data-act="folder-delete">${icon("trash", { size: 12 })}${esc(t("libDeleteFolder", "Delete folder"))}</button>`;
    }
  }

  // The free plan's folder limit, met where the user tried to make a fourth.
  const slot = $("limitSlot");
  slot.innerHTML =
    st.limitCard === "folders"
      ? limitCard({
          title: t("libFolderLimitTitle", "You've used 3 of 3 free folders"),
          body: t("libFolderLimitBody", "Pro gives you unlimited folders. Your chats and folders stay exactly as they are."),
          hit: "folders",
          cta: t("libUnlockFolders", "Unlock unlimited folders"),
          dismiss: "dismiss-limit",
        })
      : "";
}

function limitCard({ title, body, hit, cta, dismiss, extra = "" }) {
  return (
    `<div class="card card--limit" role="status">` +
    `<div class="card__title">${icon("lock")}<span>${esc(title)}</span></div>` +
    `<div class="card__body">${esc(body)}</div>` +
    `<div class="card__actions"><button class="btn btn--primary btn--sm" data-upgrade="${esc(hit)}">${esc(cta)}</button>${extra}` +
    (dismiss ? `<button class="btn btn--ghost btn--sm" data-act="${esc(dismiss)}">${esc(t("libNotNow", "Not now"))}</button>` : "") +
    `</div></div>`
  );
}

function renderSnippet(sn) {
  if (!sn) return "";
  return `<div class="row__snippet">${esc(sn.before)}${sn.match ? `<mark>${esc(sn.match)}</mark>` : ""}${esc(sn.after)}</div>`;
}

function renderList() {
  const list = $("list");
  const head = $("listHead");
  const more = $("moreBtn");
  const locked = $("lockedSlot");
  locked.innerHTML = "";
  more.hidden = true;

  if (st.loading) {
    head.hidden = true;
    list.innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton" aria-hidden="true"></div>').join("");
    list.setAttribute("aria-busy", "true");
    return;
  }
  list.removeAttribute("aria-busy");

  if (st.error) {
    head.hidden = true;
    const signedOut = st.error === "signed_out";
    list.innerHTML =
      `<div class="empty"><div class="empty__title">${icon("circle-alert")}<span>${esc(
        signedOut ? t("libSignedOutTitle", "Sign in to claude.ai") : t("libErrorTitle", "Couldn't reach claude.ai")
      )}</span></div><div>${esc(
        signedOut
          ? t("libSignedOutBody", "The Library lists the chats in your own Claude account, so it needs you signed in.")
          : t("libErrorBody", "Check your connection, then try again.")
      )}</div><div class="card__actions">` +
      (signedOut
        ? `<button class="btn btn--primary btn--sm" data-act="open-claude">${icon("external", { size: 14 })}${esc(t("libOpenClaude", "Open claude.ai"))}</button>`
        : "") +
      `<button class="btn btn--sm" data-act="retry">${icon("refresh", { size: 14 })}${esc(t("libRetry", "Try again"))}</button></div></div>`;
    return;
  }

  const rows = st.rows;
  if (!rows.length) {
    head.hidden = true;
    list.innerHTML = emptyState();
    return;
  }

  head.hidden = false;
  const selectable = selectableRows();
  const all = $("selectAll");
  all.checked = selectable.length > 0 && selectable.every((r) => st.selected.has(r.uuid));
  all.indeterminate = !all.checked && selectable.some((r) => st.selected.has(r.uuid));
  all.disabled = !selectable.length;
  $("listLabel").textContent = st.results
    ? t("libMatches", "$1 matching chats", fmtNum(st.results.length))
    : t("libCount", "$1 chats", fmtNum(selectable.length));

  const shown = rows.slice(0, st.shown);
  list.innerHTML = shown.map(rowHtml).join("");

  if (rows.length > shown.length) {
    more.hidden = false;
    more.textContent = t("libShowMore", "Show $1 more", fmtNum(Math.min(PAGE_ROWS, rows.length - shown.length)));
  }
  if (st.locked) {
    locked.innerHTML = limitCard({
      title: t("libSearchLockedTitle", "$1 more chats match", fmtNum(st.locked)),
      body: t("libSearchLockedBody", "The free plan shows the top 5 matches. Pro shows every match, in every chat."),
      hit: "search",
      cta: t("libUnlockSearch", "Unlock full search"),
    });
  }
}

function rowHtml(r) {
  if (r.kind === "project") {
    return (
      `<div class="row row--project" role="listitem" data-uuid="${esc(r.uuid)}" data-kind="project">` +
      `<span class="check">${icon("box", { size: 14 })}</span>` +
      `<div class="row__main"><button class="row__title" data-open="project">${esc(r.name || t("libUntitledProject", "Untitled project"))}</button>` +
      `<div class="row__meta"><span>${esc(t("libProject", "Project"))}</span></div></div><span></span></div>`
    );
  }
  const sel = st.selected.has(r.uuid);
  const meta = [];
  const p = r.project_uuid && st.projects.get(r.project_uuid);
  if (p) meta.push(`${icon("box", { size: 12 })}<span>${esc(p.name)}</span>`);
  const fid = chatFolder(r.uuid);
  if (fid && st.filter !== fid) meta.push(`${icon("folder", { size: 12 })}<span>${esc(folderName(fid))}</span>`);
  const title = r.name || t("libUntitledChat", "Untitled chat");
  return (
    `<div class="row${sel ? " is-selected" : ""}" role="listitem" data-uuid="${esc(r.uuid)}" data-kind="chat" draggable="true">` +
    `<label class="check"><input type="checkbox" data-sel ${sel ? "checked" : ""} aria-label="${esc(t("libSelectChat", "Select “$1”", title))}" /></label>` +
    `<div class="row__main"><button class="row__title" data-open="chat" title="${esc(title)}">${esc(title)}</button>` +
    (meta.length ? `<div class="row__meta">${meta.join("<span>·</span>")}</div>` : "") +
    renderSnippet(r.snippet) +
    `</div><span class="row__date">${esc(fmtDate(r.updated_at))}</span></div>`
  );
}

function emptyState() {
  const block = (title, body, ic = "inbox") =>
    `<div class="empty"><div class="empty__title">${icon(ic)}<span>${esc(title)}</span></div><div>${esc(body)}</div></div>`;
  if (st.query.trim()) {
    const left = st.index.running ? Math.max(0, st.index.total - st.index.done) : 0;
    return block(
      t("libNoMatchTitle", "No chat mentions “$1”", st.query.trim()),
      left
        ? t("libNoMatchIndexing", "Still indexing — $1 chats to go. Results appear as they are read.", fmtNum(left))
        : t("libNoMatchBody", "Search matches every word you type. Put a phrase in quotes to match it exactly."),
      "search"
    );
  }
  if (st.filter === "unfiled") return block(t("libUnfiledEmptyTitle", "Everything is filed"), t("libUnfiledEmptyBody", "Every chat is in a folder."), "folder");
  if (st.filter !== "all") {
    return block(
      t("libFolderEmptyTitle", "Nothing in “$1” yet", folderName(st.filter)),
      t("libFolderEmptyBody", "Select chats in All chats and choose Folder, or drag them onto this folder. On claude.ai, use + next to the folder to add the open chat."),
      "folder"
    );
  }
  return block(t("libNoChatsTitle", "No chats yet"), t("libNoChatsBody", "Chats you start on claude.ai show up here."));
}

/** Selection changes only: update rows in place, keep the DOM nodes. */
function paintSelection() {
  for (const el of document.querySelectorAll(".row[data-kind=chat]")) {
    const on = st.selected.has(el.dataset.uuid);
    el.classList.toggle("is-selected", on);
    const box = el.querySelector("input[data-sel]");
    if (box) box.checked = on;
  }
  const selectable = selectableRows();
  const all = $("selectAll");
  all.checked = selectable.length > 0 && selectable.every((r) => st.selected.has(r.uuid));
  all.indeterminate = !all.checked && selectable.some((r) => st.selected.has(r.uuid));
  renderBulk();
}

function renderBulk() {
  const bar = $("bulkBar");
  const n = st.selected.size;
  bar.hidden = n === 0 && !st.panel;
  if (bar.hidden) return;
  $("bulkCount").textContent = t("libSelected", "$1 selected", fmtNum(n));
  for (const id of ["bulkFolderBtn", "bulkProjectBtn", "bulkExportBtn", "bulkDeleteBtn"]) $(id).disabled = st.busy || n === 0;
  renderPanel();
}

function renderPanel() {
  const panel = $("bulkPanel");
  panel.hidden = !st.panel;
  if (!st.panel) {
    panel.innerHTML = "";
    return;
  }
  const n = st.selected.size;
  if (st.panel === "folder") {
    const folders = st.folders.folders;
    panel.innerHTML =
      `<div class="bulkbar__q">${esc(t("libMoveToFolderQ", "Move $1 chats to folder", fmtNum(n)))}</div>` +
      `<div class="pick">` +
      folders.map((f) => `<button data-pick-folder="${esc(f.id)}">${icon("folder", { size: 14 })}<span>${esc(f.name)}</span></button>`).join("") +
      `<button data-act="bulk-new-folder">${icon("folder-plus", { size: 14 })}<span>${esc(t("libNewFolderEllipsis", "New folder…"))}</span></button>` +
      `<button data-pick-folder="">${icon("x", { size: 14 })}<span>${esc(t("libRemoveFromFolder", "Remove from folder"))}</span></button>` +
      `</div>`;
  } else if (st.panel === "project") {
    const projects = [...st.projects.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    panel.innerHTML =
      `<div class="bulkbar__q">${esc(t("libMoveToProjectQ", "Move $1 chats to a Claude project", fmtNum(n)))}</div>` +
      (projects.length
        ? `<div class="pick">${projects
            .map((p) => `<button data-pick-project="${esc(p.uuid)}">${icon("box", { size: 14 })}<span>${esc(p.name || t("libUntitledProject", "Untitled project"))}</span></button>`)
            .join("")}</div>`
        : `<div class="bulkbar__note">${esc(t("libNoProjects", "This account has no projects yet. Create one on claude.ai first."))}</div>`) +
      `<div class="bulkbar__note">${esc(t("libMoveNote", "This changes the chats on claude.ai, the same as moving them there."))}</div>`;
  } else if (st.panel === "delete") {
    panel.innerHTML =
      `<div class="bulkbar__q">${esc(t("libDeleteQ", "Delete $1 chats from your Claude account?", fmtNum(n)))}</div>` +
      `<div class="bulkbar__note">${esc(t("libDeleteNote", "They are deleted on claude.ai and can't be restored. Export them first if you might need them."))}</div>` +
      `<div class="bulkbar__actions"><button class="btn btn--sm" data-act="panel-close">${esc(t("libCancel", "Cancel"))}</button>` +
      `<button class="btn btn--sm btn--danger-solid" data-act="delete-yes">${icon("trash", { size: 14 })}${esc(t("libDeleteN", "Delete $1 chats", fmtNum(n)))}</button></div>`;
  } else if (st.panel === "export") {
    panel.innerHTML =
      `<div class="bulkbar__q">${esc(t("libExportQ", "Export $1 chats as", fmtNum(n)))}</div>` +
      `<div class="pick">` +
      `<button data-act="export-md">${icon("download", { size: 14 })}<span>${esc(t("libExportMd", "ZIP of Markdown files"))}</span></button>` +
      `<button data-act="export-pdf">${icon("download", { size: 14 })}<span>${esc(t("libExportPdf", "One PDF (opens Save as PDF)"))}</span></button>` +
      `</div>`;
  } else if (st.panel === "limit") {
    panel.innerHTML = st.panelHtml || "";
  } else if (st.panel === "progress") {
    const p = st.progress || { done: 0, total: 0, label: "" };
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    panel.innerHTML =
      `<div class="bulkbar__note">${esc(p.label)} <span style="font-family:var(--mono)">${fmtNum(p.done)} / ${fmtNum(p.total)}</span></div>` +
      `<div class="progress"><i style="width:${pct}%"></i></div>`;
  } else if (st.panel === "notab") {
    panel.innerHTML =
      `<div class="bulkbar__q">${esc(t("libNoTabTitle", "Open claude.ai in a tab first"))}</div>` +
      `<div class="bulkbar__note">${esc(t("libNoTabBody", "Moving and deleting run on claude.ai itself, signed in as you. Keep a claude.ai tab open, then try again."))}</div>` +
      `<div class="bulkbar__actions"><button class="btn btn--sm" data-act="panel-close">${esc(t("libCancel", "Cancel"))}</button>` +
      `<button class="btn btn--sm btn--primary" data-act="open-claude">${icon("external", { size: 14 })}${esc(t("libOpenClaude", "Open claude.ai"))}</button></div>`;
  }
}

let toastTimer = null;
function toast(msg, { err = false } = {}) {
  const el = $("toast");
  el.className = "toast" + (err ? " toast--err" : "");
  el.innerHTML = `${icon(err ? "circle-alert" : "check")}<span>${esc(msg)}</span>`;
  el.hidden = false;
  if (err) noteError("library", msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function load() {
  st.loading = true;
  st.error = null;
  render();
  try {
    st.orgId = await resolveOrg();
    if (!st.orgId) throw Object.assign(new Error("no org"), { status: 401 });
    const api = `${ORIGIN}/api/organizations/${st.orgId}`;
    const [chats, projects] = await Promise.all([
      fetchAll((l, o) => `${api}/chat_conversations_v2?limit=${l}&offset=${o}`),
      fetchAll((l, o) => `${api}/projects?limit=${l}&offset=${o}`).catch(() => []),
    ]);
    st.chats = chats
      .filter((c) => !c.is_temporary)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    st.chatById = new Map(st.chats.map((c) => [c.uuid, c]));
    st.projects = new Map(projects.map((p) => [p.uuid, { uuid: p.uuid, name: p.name || "" }]));
    // Titles change on claude.ai; keep the sidebar's copies current.
    let next = F.refreshNames(st.folders, "chat", st.chats);
    next = F.refreshNames(next, "project", projects);
    if (next !== st.folders) await saveFolders(next);
    // Indexing starts now; don't claim "searched on this computer" before it has.
    st.index.running = true;
    st.loading = false;
    render();
    syncIndex();
  } catch (err) {
    st.loading = false;
    st.error = err && (err.status === 401 || err.status === 403) ? "signed_out" : "network";
    render();
  }
}

// ── Search index ────────────────────────────────────────────────────────────

let indexRun = 0;
async function syncIndex() {
  const run = ++indexRun;
  const ix = st.index;
  let store;
  try {
    store = await openIndex(st.orgId);
  } catch {
    // No IndexedDB (rare: a locked-down profile). Titles stay searchable.
    for (const c of st.chats) st.docs.set(c.uuid, S.prepare([{ ...c, text: "" }])[0]);
    return;
  }
  const records = await store.all();
  const meta = {};
  for (const r of records) meta[r.uuid] = { updated_at: r.updated_at, failed: r.failed };
  const plan = S.planSync(st.chats, meta);
  await store.remove(plan.drop);

  // Searchable at once: indexed text where we have it, titles for the rest.
  const byId = new Map(records.map((r) => [r.uuid, r]));
  st.docs = new Map();
  for (const c of st.chats) {
    const r = byId.get(c.uuid);
    st.docs.set(c.uuid, S.prepare([{ uuid: c.uuid, name: c.name, updated_at: c.updated_at, project_uuid: c.project_uuid, text: (r && r.text) || "" }])[0]);
  }

  Object.assign(ix, { done: 0, total: plan.fetch.length, running: plan.fetch.length > 0, failed: 0, error: null });
  render();

  let pending = [];
  const flush = async () => {
    const batch = pending;
    pending = [];
    await store.put(batch).catch(() => {});
    if (st.query.trim()) render();
    else renderIndexLine();
  };

  const queue = plan.fetch.slice();
  async function worker() {
    while (queue.length && run === indexRun && !ix.error) {
      const c = queue.shift();
      const rec = { uuid: c.uuid, name: c.name || "", updated_at: c.updated_at, project_uuid: c.project_uuid || null, text: "" };
      try {
        const tr = await getJson(transcriptUrl(c.uuid));
        rec.text = S.searchText(tr, window.transcriptToMarkdown);
      } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) ix.error = "signed_out";
        rec.failed = true;
        ix.failed += 1;
      }
      st.docs.set(c.uuid, S.prepare([rec])[0]);
      pending.push(rec);
      ix.done += 1;
      if (pending.length >= 10) await flush();
      await sleep(INDEX_GAP_MS);
    }
  }
  await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, worker));
  if (run !== indexRun) return;
  await flush();
  ix.running = false;
  store.close();
  render();
}

// ── Folder actions ──────────────────────────────────────────────────────────

async function createFolder(name, then) {
  const r = F.createFolder(st.folders, name, { isPro: st.isPro });
  if (!r.ok) {
    if (r.error === "limit") {
      st.folderEdit = null;
      st.limitCard = "folders";
      render();
    } else if (r.error === "duplicate") toast(t("libFolderExists", "There is already a folder with that name."), { err: true });
    return null;
  }
  await saveFolders(r.state);
  st.folderEdit = null;
  if (then) await then(r.folder);
  render();
  return r.folder;
}

async function fileSelection(folderId) {
  const uuids = [...st.selected];
  const items = uuids.map((u) => ({ kind: "chat", uuid: u, name: (st.chatById.get(u) || {}).name || "" }));
  await saveFolders(F.assign(st.folders, items, folderId || null));
  st.panel = null;
  st.selected.clear();
  toast(
    folderId
      ? t("libFiled", "Moved $1 chats to “$2”", [fmtNum(uuids.length), folderName(folderId)])
      : t("libUnfiled", "Removed $1 chats from their folder", fmtNum(uuids.length))
  );
  render();
}

// ── Bulk actions on claude.ai ───────────────────────────────────────────────

/** The free plan's per-action cap, met with the selection intact. */
function gateBulk(action) {
  const n = st.selected.size;
  const ok = B.bulkAllowed(n, st.isPro);
  if (ok.ok) return true;
  st.panel = "limit";
  st.panelHtml = limitCard({
    title: t("libBulkLimitTitle", "Free plan: $1 chats per bulk action", String(B.FREE_BULK_LIMIT)),
    body: t("libBulkLimitBody", "You selected $1. Pro moves, exports, and deletes any number at once.", fmtNum(n)),
    hit: "bulk",
    cta: t("libUnlockBulk", "Unlock bulk actions"),
    extra: `<button class="btn btn--sm" data-act="keep-first" data-then="${esc(action)}">${esc(t("libKeepFirst", "Use the first $1", String(B.FREE_BULK_LIMIT)))}</button>`,
    dismiss: "panel-close",
  });
  render();
  return false;
}

function orderedSelection() {
  // Keep the on-screen order, so "the first 5" means the five the user sees first.
  return selectableRows().map((r) => r.uuid).filter((u) => st.selected.has(u));
}

async function runWrite(kind, projectUuid) {
  const uuids = orderedSelection();
  st.busy = true;
  st.panel = "progress";
  const label = kind === "delete" ? t("libDeleting", "Deleting") : t("libMoving", "Moving");
  st.progress = { done: 0, total: uuids.length, label };
  render();
  const onProgress = (done, total) => {
    st.progress = { done, total, label };
    renderPanel();
  };
  let res;
  try {
    res =
      kind === "delete"
        ? await B.deleteChats(postFromClaudeTab, st.orgId, uuids, onProgress)
        : await B.moveChats(postFromClaudeTab, st.orgId, uuids, projectUuid, onProgress);
  } catch (err) {
    res = { done: [], failed: uuids, err };
  }
  st.busy = false;

  // B.* swallow per-batch errors; if nothing worked and no tab was there, say so.
  if (!res.done.length && (await chrome.tabs.query({ url: "https://claude.ai/*" })).length === 0) {
    st.panel = "notab";
    render();
    return;
  }

  if (kind === "delete") {
    const gone = new Set(res.done);
    st.chats = st.chats.filter((c) => !gone.has(c.uuid));
    st.chatById = new Map(st.chats.map((c) => [c.uuid, c]));
    for (const u of gone) st.docs.delete(u);
    await saveFolders(F.forget(st.folders, "chat", res.done));
    openIndex(st.orgId).then((s) => s.remove(res.done).then(() => s.close())).catch(() => {});
  } else {
    for (const u of res.done) {
      const c = st.chatById.get(u);
      if (c) c.project_uuid = projectUuid;
    }
  }
  st.selected = new Set(res.failed);
  st.panel = null;
  const ok = res.done.length;
  if (res.failed.length) {
    toast(
      kind === "delete"
        ? t("libDeletePartial", "Deleted $1. $2 could not be deleted and are still selected.", [fmtNum(ok), fmtNum(res.failed.length)])
        : t("libMovePartial", "Moved $1. $2 could not be moved and are still selected.", [fmtNum(ok), fmtNum(res.failed.length)]),
      { err: true }
    );
  } else {
    const p = st.projects.get(projectUuid);
    toast(
      kind === "delete"
        ? t("libDeleted", "Deleted $1 chats. Reload claude.ai to see the change.", fmtNum(ok))
        : t("libMoved", "Moved $1 chats to “$2”", [fmtNum(ok), (p && p.name) || t("libProject", "Project")])
    );
  }
  render();
}

// v1.17: Export asks ZIP of Markdown or one PDF. The PDF is laid out by
// print/print.html, which fetches the chats itself; each chat still counts as
// one download on the free plan, same as the ZIP.
async function exportSelection(format = "md") {
  const uuids = orderedSelection();
  if (!st.isPro) {
    const left = await getRemainingDownloads();
    if (uuids.length > left) {
      st.panel = "limit";
      st.panelHtml = limitCard({
        title: t("libExportLimitTitle", "$1 of 5 free downloads left today", String(left)),
        body: t("libExportLimitBody", "Each exported chat counts as one download. Pro exports any number of chats, any day."),
        hit: "bulk",
        cta: t("libUnlockExports", "Unlock unlimited exports"),
        extra: left > 0 ? `<button class="btn btn--sm" data-act="keep-first" data-then="export:${format}" data-n="${left}">${esc(t("libKeepFirst", "Use the first $1", String(left)))}</button>` : "",
        dismiss: "panel-close",
      });
      render();
      return;
    }
  }
  if (format === "pdf") {
    const title = st.filter !== "all" && st.filter !== "unfiled"
      ? (st.folders.folders.find((f) => f.id === st.filter) || {}).name
      : "";
    const q = new URLSearchParams({ chats: uuids.join(","), org: st.orgId || "" });
    if (title) q.set("title", title);
    chrome.tabs.create({ url: chrome.runtime.getURL(`print/print.html?${q}`) });
    if (!st.isPro) for (let k = 0; k < uuids.length; k += 1) await recordDownload();
    st.panel = null;
    st.selected.clear();
    toast(t("libPdfOpened", "PDF of $1 chats opened in a new tab", fmtNum(uuids.length)));
    return render();
  }
  st.busy = true;
  st.panel = "progress";
  const label = t("libExporting", "Exporting");
  st.progress = { done: 0, total: uuids.length, label };
  render();

  const stamp = new Date().toISOString().slice(0, 10);
  const folder = `Claude chats ${stamp}`;
  const zip = new window.TinyZip();
  const names = new Set();
  const failed = [];
  let done = 0;
  for (let i = 0; i < uuids.length; i += 2) {
    await Promise.all(
      uuids.slice(i, i + 2).map(async (u) => {
        const c = st.chatById.get(u) || {};
        try {
          const tr = await getJson(transcriptUrl(u));
          if (!tr.name) tr.name = c.name || "";
          let name = window.sanitizeChatFilename(tr.name, u, "md");
          while (names.has(name.toLowerCase())) name = name.replace(/\.md$/, "-2.md");
          names.add(name.toLowerCase());
          zip.addFile(`${folder}/${name}`, window.transcriptToMarkdown(tr));
        } catch {
          failed.push(c.name || u);
        } finally {
          done += 1;
          st.progress = { done, total: uuids.length, label };
          renderPanel();
        }
      })
    );
  }
  const saved = uuids.length - failed.length;
  if (saved > 0) {
    if (failed.length) zip.addFile(`${folder}/NOT EXPORTED.txt`, failed.join("\n") + "\n");
    const blob = await zip.generateBlob();
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename: `${folder}.zip`, conflictAction: "uniquify", saveAs: false });
      if (!st.isPro) for (let k = 0; k < saved; k += 1) await recordDownload();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
  st.busy = false;
  st.panel = null;
  if (failed.length) toast(t("libExportPartial", "Exported $1. $2 could not be read.", [fmtNum(saved), fmtNum(failed.length)]), { err: true });
  else {
    st.selected.clear();
    toast(t("libExported", "Exported $1 chats to Downloads", fmtNum(saved)));
  }
  render();
}

// ── Opening things ──────────────────────────────────────────────────────────

async function openOnClaude(path) {
  const url = ORIGIN + path;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && /^https:\/\/claude\.ai\//.test(tab.url || "")) chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url });
}

// ── Events ──────────────────────────────────────────────────────────────────

function setSelected(uuid, on) {
  if (on) st.selected.add(uuid);
  else st.selected.delete(uuid);
}

function onListClick(e) {
  const row = e.target.closest(".row");
  if (!row) return;
  const uuid = row.dataset.uuid;
  const open = e.target.closest("[data-open]");
  if (open) {
    openOnClaude(row.dataset.kind === "project" ? `/project/${uuid}` : `/chat/${uuid}`);
    return;
  }
  const box = e.target.closest("input[data-sel]");
  if (!box) return;
  const rows = selectableRows();
  if (e.shiftKey && st.anchor) {
    const a = rows.findIndex((r) => r.uuid === st.anchor);
    const b = rows.findIndex((r) => r.uuid === uuid);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i += 1) setSelected(rows[i].uuid, box.checked);
    }
  } else setSelected(uuid, box.checked);
  st.anchor = uuid;
  if (st.panel && st.panel !== "progress") st.panel = null;
  paintSelection();
}

async function onAction(act, el) {
  switch (act) {
    case "retry":
      return load();
    case "open-claude":
      return chrome.tabs.create({ url: `${ORIGIN}/recents` });
    case "dismiss-limit":
      st.limitCard = null;
      return render();
    case "panel-close":
      st.panel = null;
      return render();
    case "keep-first": {
      const n = Number(el.dataset.n) || B.FREE_BULK_LIMIT;
      st.selected = new Set(orderedSelection().slice(0, n));
      st.panel = null;
      render();
      return startBulk(el.dataset.then);
    }
    case "delete-yes":
      return runWrite("delete");
    case "export-md":
      st.panel = null;
      return exportSelection("md");
    case "export-pdf":
      st.panel = null;
      return exportSelection("pdf");
    case "bulk-new-folder":
      st.panel = null;
      st.pendingFile = true;
      st.folderEdit = "new";
      return render();
    case "folder-rename":
      st.folderEdit = "rename";
      return render();
    case "folder-delete":
      st.folderEdit = "delete";
      return render();
    case "folder-cancel":
      st.folderEdit = null;
      return render();
    case "folder-delete-yes": {
      const name = folderName(st.filter);
      await saveFolders(F.deleteFolder(st.folders, st.filter));
      st.filter = "all";
      st.folderEdit = null;
      st.limitCard = null;
      toast(t("libFolderDeleted", "Deleted folder “$1”. Its chats are unfiled.", name));
      return render();
    }
  }
}

function startBulk(kind) {
  if (!st.selected.size || st.busy) return;
  if (kind === "folder") {
    st.panel = st.panel === "folder" ? null : "folder";
    return render();
  }
  if (!gateBulk(kind)) return;
  if (kind === "project") {
    st.panel = st.panel === "project" ? null : "project";
    return render();
  }
  if (kind === "delete") {
    st.panel = "delete";
    render();
    const yes = document.querySelector('[data-act="delete-yes"]');
    if (yes) yes.focus();
    return;
  }
  if (kind === "export") {
    st.panel = st.panel === "export" ? null : "export";
    return render();
  }
  if (kind === "export:md") return exportSelection("md");
  if (kind === "export:pdf") return exportSelection("pdf");
}

// Text entry swallows shortcuts; a ticked checkbox must not, or F/P/E/Del
// would do nothing right after selecting a chat.
function inField(e) {
  const el = e.target;
  const tag = (el && el.tagName) || "";
  if (tag === "INPUT") return !/^(checkbox|radio|button)$/i.test(el.type);
  return tag === "TEXTAREA" || tag === "SELECT" || !!(el && el.isContentEditable);
}

function wire() {
  // Icons into static buttons.
  $("openTabBtn").innerHTML = icon("external");
  document.querySelector(".search__icon").innerHTML = icon("search");
  $("bulkFolderBtn").innerHTML = `${icon("folder", { size: 14 })}<span>${esc(t("libFolder", "Folder"))}</span>`;
  $("bulkProjectBtn").innerHTML = `${icon("box", { size: 14 })}<span>${esc(t("libProject", "Project"))}</span>`;
  $("bulkExportBtn").innerHTML = `${icon("download", { size: 14 })}<span>${esc(t("libExport", "Export"))}</span>`;
  $("bulkDeleteBtn").innerHTML = `${icon("trash", { size: 14 })}<span>${esc(t("libDelete", "Delete"))}</span>`;
  $("bulkClearBtn").innerHTML = icon("x");

  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  if (params.get("tab") === "1") $("openTabBtn").hidden = true;
  if (mode === "popup") document.documentElement.classList.add("is-popup");
  if (mode) {
    $("tabExport").href = `../popup/popup.html?mode=${encodeURIComponent(mode)}`;
    $("tabLibrary").href = `library.html?mode=${encodeURIComponent(mode)}`;
  }
  $("openTabBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("library/library.html?tab=1") });

  let searchTimer = null;
  $("searchInput").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      st.query = e.target.value;
      st.shown = PAGE_ROWS;
      render();
    }, 120);
  });
  $("indexSyncBtn").onclick = () => syncIndex();

  $("list").addEventListener("click", onListClick);
  $("moreBtn").onclick = () => {
    st.shown += PAGE_ROWS;
    render();
  };
  $("selectAll").onchange = (e) => {
    for (const r of selectableRows()) setSelected(r.uuid, e.target.checked);
    st.panel = null;
    paintSelection();
  };

  // Folder chips: filter, create.
  $("folderBar").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) {
      st.filter = chip.dataset.filter;
      st.folderEdit = null;
      st.shown = PAGE_ROWS;
      return render();
    }
    if (e.target.closest("#newFolderBtn")) {
      if (!F.canCreateFolder(st.folders, st.isPro)) {
        st.limitCard = "folders";
        return render();
      }
      st.folderEdit = "new";
      return render();
    }
  });
  $("folderBar").addEventListener("keydown", async (e) => {
    if (e.target.id !== "newFolderInput") return;
    if (e.key === "Escape") {
      st.folderEdit = null;
      st.pendingFile = false;
      return render();
    }
    if (e.key !== "Enter") return;
    const fileAfter = st.pendingFile;
    st.pendingFile = false;
    await createFolder(e.target.value, fileAfter && st.selected.size ? (f) => fileSelection(f.id) : null);
  });
  $("folderBar").addEventListener("focusout", (e) => {
    if (e.target.id === "newFolderInput" && !e.target.value.trim()) {
      st.folderEdit = null;
      setTimeout(render, 0);
    }
  });
  $("folderTools").addEventListener("keydown", async (e) => {
    if (e.target.id !== "renameFolderInput") return;
    if (e.key === "Escape") {
      st.folderEdit = null;
      return render();
    }
    if (e.key !== "Enter") return;
    const r = F.renameFolder(st.folders, st.filter, e.target.value);
    if (!r.ok) {
      if (r.error === "duplicate") toast(t("libFolderExists", "There is already a folder with that name."), { err: true });
      return;
    }
    await saveFolders(r.state);
    st.folderEdit = null;
    render();
  });

  // Drag chats onto a folder chip.
  $("list").addEventListener("dragstart", (e) => {
    const row = e.target.closest(".row[data-kind=chat]");
    if (!row) return;
    if (!st.selected.has(row.dataset.uuid)) {
      st.selected = new Set([row.dataset.uuid]);
      // Not render(): replacing the rows would remove the element being
      // dragged, and Chrome cancels a drag whose source leaves the DOM.
      paintSelection();
    }
    e.dataTransfer.setData("text/x-cpd-chats", JSON.stringify([...st.selected]));
    e.dataTransfer.effectAllowed = "move";
  });
  $("folderBar").addEventListener("dragover", (e) => {
    const chip = e.target.closest("[data-folder]");
    if (!chip || !e.dataTransfer.types.includes("text/x-cpd-chats")) return;
    e.preventDefault();
    chip.classList.add("chip--drop");
  });
  $("folderBar").addEventListener("dragleave", (e) => {
    const chip = e.target.closest("[data-folder]");
    if (chip) chip.classList.remove("chip--drop");
  });
  $("folderBar").addEventListener("drop", async (e) => {
    const chip = e.target.closest("[data-folder]");
    if (!chip) return;
    e.preventDefault();
    try {
      st.selected = new Set(JSON.parse(e.dataTransfer.getData("text/x-cpd-chats")));
    } catch {
      return;
    }
    await fileSelection(chip.dataset.folder);
  });

  // Delegated buttons anywhere: actions, upgrades, pickers.
  document.addEventListener("click", (e) => {
    const up = e.target.closest("[data-upgrade]");
    if (up) {
      e.preventDefault();
      return openUpgrade(up.dataset.upgrade);
    }
    const act = e.target.closest("[data-act]");
    if (act) return onAction(act.dataset.act, act);
    const pf = e.target.closest("[data-pick-folder]");
    if (pf) return fileSelection(pf.dataset.pickFolder || null);
    const pp = e.target.closest("[data-pick-project]");
    if (pp) return runWrite("move", pp.dataset.pickProject);
  });

  $("bulkFolderBtn").onclick = () => startBulk("folder");
  $("bulkProjectBtn").onclick = () => startBulk("project");
  $("bulkExportBtn").onclick = () => startBulk("export");
  $("bulkDeleteBtn").onclick = () => startBulk("delete");
  $("bulkClearBtn").onclick = () => {
    st.selected.clear();
    st.panel = null;
    render();
  };

  // Keyboard: / search · Esc back out · ⌘/Ctrl+A select all · F P E Del bulk · N new folder.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (inField(e) && e.target.id === "searchInput" && e.target.value) {
        e.target.value = "";
        st.query = "";
        return render();
      }
      if (st.panel && !st.busy) st.panel = null;
      else if (st.selected.size) st.selected.clear();
      else if (st.limitCard) st.limitCard = null;
      return render();
    }
    if (inField(e) || e.altKey) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      for (const r of selectableRows()) st.selected.add(r.uuid);
      return render();
    }
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === "/") {
      e.preventDefault();
      return $("searchInput").focus();
    }
    const k = e.key.toLowerCase();
    if (k === "n") {
      e.preventDefault();
      $("newFolderBtn") && $("newFolderBtn").click();
      return;
    }
    if (!st.selected.size) return;
    if (k === "f") return startBulk("folder");
    if (k === "p") return startBulk("project");
    if (k === "e") return startBulk("export");
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      return startBulk("delete");
    }
  });

  // Folders change from the claude.ai sidebar too; licence changes from the panel.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (F.FOLDERS_KEY in changes) {
      await loadFolders();
      render();
    }
    if ("isPro" in changes) {
      st.isPro = (await checkLicense()).isPro;
      if (st.isPro) st.limitCard = null;
      renderPlan();
      render();
    }
  });

  const toggle = $("sidebarToggle");
  chrome.storage.local.get(SIDEBAR_KEY).then((d) => (toggle.checked = d[SIDEBAR_KEY] !== false));
  toggle.onchange = () => chrome.storage.local.set({ [SIDEBAR_KEY]: toggle.checked });
}

function renderPlan() {
  const el = $("planLine");
  el.innerHTML = st.isPro
    ? esc(t("libPlanPro", "Pro · no limits"))
    : `${esc(t("libPlanFree", "Free plan"))} · <a href="#" data-upgrade="library">${esc(t("upgradeLink", "Upgrade to Pro"))}</a>`;
}

async function init() {
  if (window.i18n && window.i18n.translateDOM) window.i18n.translateDOM(document);
  // First, so the Report button works even if loading below fails.
  initReport({
    page: "library",
    button: $("reportBtn"),
    getContext: () => ({
      chats: st.chats.length,
      projects: st.projects.size,
      error: st.error || undefined,
      indexed: `${st.index.done}/${st.index.total}${st.index.failed ? `, ${st.index.failed} failed` : ""}`,
      search: st.query ? "active" : undefined,
    }),
  });
  st.isPro = (await checkLicense()).isPro;
  await loadFolders();
  wire();
  renderPlan();
  await load();
}

init();
