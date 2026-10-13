(() => {
  "use strict";

  // Folders in claude.ai's own sidebar (v1.16): a "Folders" section above
  // Recents, listing each folder and the chats and projects filed in it.
  // "+" on a folder files whatever chat or project is open. Bulk filing,
  // renaming, and search live in the Library (side panel), which writes the
  // same chrome.storage state (lib/folders.js) — so both stay in step.
  //
  // Anchored on data-testid="sidebar-recents", which claude.ai's sidebar has
  // carried since its 2026 redesign; re-attached from a throttled
  // MutationObserver when React re-renders the sidebar. No Recents section on
  // the page (settings, a collapsed sidebar) means no Folders section.
  //
  // Drawn in a shadow root that inherits the sidebar's font and colour, and
  // reuses claude.ai's own --df-* row variables where they exist, so it reads
  // as part of the sidebar without claude.ai's CSS reaching in.
  if (window.__CPD_SIDEBAR_FOLDERS__) return;
  window.__CPD_SIDEBAR_FOLDERS__ = true;

  const F = window.CpdFolders;
  if (!F) return;

  const HOST_ID = "cpd-sidebar-folders";
  const ANCHOR = '[data-testid="sidebar-recents"]';
  const UI_KEY = "cpdFoldersUi"; // { open: { [folderId]: true }, collapsed: bool }
  const SHOW_KEY = "sidebarFolders";
  const MAX_ITEMS = 15;

  let state = F.emptyState();
  let ui = { open: {}, collapsed: false };
  let isPro = false;
  let enabled = true;
  let creating = false;
  let limitHit = false;
  let host = null;
  let root = null;

  function msg(key, fallback, subs) {
    try {
      const m = chrome.i18n.getMessage(key, subs);
      if (m) return m;
    } catch {
      /* extension reloaded underneath us */
    }
    if (subs == null) return fallback;
    return [].concat(subs).reduce((s, v, i) => s.replace(`$${i + 1}`, v), fallback);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Lucide paths, 16px / 1.5 stroke like the rest of the extension.
  const ICON = {
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };
  const svg = (n, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

  const CSS = `
    :host { display: block; font: inherit; color: inherit; margin: 0 0 8px; }
    * { box-sizing: border-box; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 6px; height: 28px; }
    .label { all: unset; cursor: pointer; font-size: 12px; line-height: 1; opacity: .6; display: inline-flex; align-items: center; gap: 2px; }
    .label svg { display: block; }
    .label:hover { opacity: .9; }
    .label svg { transition: transform .12s; transform: rotate(90deg); }
    .label[aria-expanded="false"] svg { transform: none; }
    .ib { all: unset; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; opacity: .55; }
    .ib:hover { opacity: 1; background: var(--df-hover, rgba(127,127,127,.12)); }
    .ib:focus-visible, .row:focus-visible, .item:focus-visible, .label:focus-visible { outline: 2px solid #d97757; outline-offset: -2px; }
    .folder { position: relative; }
    .row { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; height: 32px;
      padding: 0 36px 0 8px; border-radius: var(--df-radius-pill, 8px); cursor: pointer; font-size: var(--df-row-font, 14px); }
    .row:hover, .item:hover { background: var(--df-hover, rgba(127,127,127,.12)); }
    .row svg { flex: none; opacity: .7; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .n { font-size: 11px; opacity: .5; font-variant-numeric: tabular-nums; }
    .folder .ib { position: absolute; right: 6px; top: 4px; opacity: 0; }
    .folder:hover .ib, .folder .ib:focus-visible { opacity: .6; }
    .folder .ib:hover { opacity: 1; }
    .folder .ib.done { opacity: .8; color: #3f8f58; }
    .items { padding: 0 0 4px 16px; }
    .item { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-radius: var(--df-radius-pill, 8px);
      color: inherit; text-decoration: none; font-size: 13px; opacity: .85; }
    .item svg { flex: none; opacity: .5; }
    .item.here { background: var(--df-hover, rgba(127,127,127,.12)); opacity: 1; }
    .item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .more, .empty, .note { font-size: 12px; opacity: .6; padding: 4px 10px; }
    .more, .note button { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .more { display: block; }
    .note { opacity: .8; display: grid; gap: 2px; }
    .note button { color: #d97757; font-weight: 500; }
    input { width: calc(100% - 16px); margin: 2px 8px 4px; height: 30px; padding: 0 8px; font: inherit; font-size: 13px;
      color: inherit; background: transparent; border: 1px solid #d97757; border-radius: 8px; outline: none; }
  `;

  function currentPage() {
    const parts = location.pathname.split("/").filter(Boolean);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (parts[0] === "chat" && UUID.test(parts[1] || "")) return { kind: "chat", uuid: parts[1] };
    if (parts[0] === "project" && UUID.test(parts[1] || "")) return { kind: "project", uuid: parts[1] };
    return null;
  }

  function pageTitle() {
    return document.title.replace(/\s*[-–|]\s*Claude\s*$/i, "").trim();
  }

  async function save(next) {
    state = F.normalize(next);
    await chrome.storage.local.set({ [F.FOLDERS_KEY]: state });
  }

  function saveUi() {
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
  }

  function render() {
    if (!root) return;
    const here = currentPage();
    const counts = F.counts(state);
    let html = `<style>${CSS}</style><div class="head">
      <button class="label" data-act="collapse" aria-expanded="${!ui.collapsed}">${esc(msg("sbFolders", "Folders"))}${svg("chevron", 12)}</button>
      <button class="ib" data-act="new" title="${esc(msg("sbNewFolder", "New folder"))}" aria-label="${esc(msg("sbNewFolder", "New folder"))}">${svg("plus", 14)}</button>
    </div>`;
    if (!ui.collapsed) {
      if (creating) html += `<input id="name" maxlength="60" placeholder="${esc(msg("libFolderNamePh", "Folder name"))}" aria-label="${esc(msg("libFolderNamePh", "Folder name"))}" />`;
      if (limitHit) {
        html += `<div class="note"><span>${esc(msg("sbLimit", "Free plan includes 3 folders."))}</span><button data-act="upgrade">${esc(msg("sbUnlock", "Unlock unlimited folders"))}</button></div>`;
      }
      if (!state.folders.length && !creating) {
        html += `<div class="empty">${esc(msg("sbEmpty", "Group chats and projects into folders. Press + to start."))}</div>`;
      }
      for (const f of state.folders) {
        const open = !!ui.open[f.id];
        const filedHere = here && F.folderOf(state, here.kind, here.uuid) === f.id;
        const fileLabel = here
          ? filedHere
            ? msg("sbInFolder", "Already in $1", f.name)
            : msg(here.kind === "project" ? "sbAddProject" : "sbAddChat", here.kind === "project" ? "Add this project to $1" : "Add this chat to $1", f.name)
          : "";
        html += `<div class="folder"><button class="row" data-act="toggle" data-id="${esc(f.id)}" aria-expanded="${open}">
            ${svg(open ? "folderOpen" : "folder")}<span class="name">${esc(f.name)}</span><span class="n">${counts[f.id] || ""}</span></button>`;
        if (here) {
          html += `<button class="ib${filedHere ? " done" : ""}" data-act="file" data-id="${esc(f.id)}" title="${esc(fileLabel)}" aria-label="${esc(fileLabel)}">${svg(filedHere ? "check" : "plus", 14)}</button>`;
        }
        html += `</div>`;
        if (open) {
          const items = F.itemsIn(state, f.id);
          html += `<div class="items">`;
          if (!items.length) html += `<div class="empty">${esc(msg("sbFolderEmpty", "Empty. Open a chat and press + on this folder."))}</div>`;
          for (const it of items.slice(0, MAX_ITEMS)) {
            const href = it.kind === "project" ? `/project/${it.uuid}` : `/chat/${it.uuid}`;
            const isHere = here && here.uuid === it.uuid;
            const title = it.name || msg(it.kind === "project" ? "libUntitledProject" : "libUntitledChat", it.kind === "project" ? "Untitled project" : "Untitled chat");
            html += `<a class="item${isHere ? " here" : ""}" href="${href}" title="${esc(title)}"${isHere ? ' aria-current="page"' : ""}>${svg(it.kind === "project" ? "box" : "message", 14)}<span>${esc(title)}</span></a>`;
          }
          if (items.length > MAX_ITEMS) {
            html += `<button class="more" data-act="library">${esc(msg("sbShowAll", "Show all $1 in the Library", String(items.length)))}</button>`;
          }
          html += `</div>`;
        }
      }
    }
    root.innerHTML = html;
    const input = root.getElementById("name");
    if (input) input.focus();
  }

  async function onClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    e.preventDefault();
    e.stopPropagation();
    if (act === "collapse") {
      ui.collapsed = !ui.collapsed;
      saveUi();
    } else if (act === "toggle") {
      ui.open[btn.dataset.id] = !ui.open[btn.dataset.id];
      saveUi();
    } else if (act === "new") {
      ui.collapsed = false;
      if (!F.canCreateFolder(state, isPro)) limitHit = true;
      else creating = true;
    } else if (act === "file") {
      const here = currentPage();
      if (!here) return;
      const id = btn.dataset.id;
      const already = F.folderOf(state, here.kind, here.uuid) === id;
      await save(F.assign(state, [{ ...here, name: pageTitle() }], already ? null : id));
      ui.open[id] = true;
      saveUi();
    } else if (act === "upgrade") {
      chrome.runtime.sendMessage({ type: "OPEN_UPGRADE", hit: "folders" }).catch(() => {});
    } else if (act === "library") {
      chrome.runtime.sendMessage({ type: "OPEN_LIBRARY" }).catch(() => {});
    }
    render();
  }

  async function onKey(e) {
    if (e.target.id !== "name") return;
    e.stopPropagation(); // keep claude.ai's own shortcuts out of the name field
    if (e.key === "Escape") {
      creating = false;
      return render();
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const r = F.createFolder(state, e.target.value, { isPro });
    if (r.ok) {
      creating = false;
      ui.open[r.folder.id] = true;
      saveUi();
      await save(r.state);
    } else if (r.error === "limit") {
      creating = false;
      limitHit = true;
    } else if (r.error === "empty_name") {
      creating = false;
    }
    render();
  }

  function mount() {
    if (!enabled) {
      if (host) host.remove();
      return;
    }
    const anchor = document.querySelector(ANCHOR);
    if (!anchor || !anchor.parentElement) return;
    if (host && host.isConnected && host.nextElementSibling === anchor) return;
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      root = host.attachShadow({ mode: "open" });
      root.addEventListener("click", onClick);
      root.addEventListener("keydown", onKey, true);
      root.addEventListener("focusout", (e) => {
        if (e.target.id === "name" && !e.target.value.trim()) {
          creating = false;
          setTimeout(render, 0);
        }
      });
    }
    anchor.parentElement.insertBefore(host, anchor);
    render();
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      mount();
    }, 400);
  }

  let lastPath = location.pathname;
  function onMutate() {
    // An SPA navigation changes which folder rows get a "+" and which item is current.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      render();
    }
    if (!host || !host.isConnected) schedule();
  }

  async function start() {
    const data = await chrome.storage.local.get([F.FOLDERS_KEY, UI_KEY, SHOW_KEY, "isPro"]);
    state = F.normalize(data[F.FOLDERS_KEY]);
    ui = { open: {}, collapsed: false, ...(data[UI_KEY] || {}) };
    enabled = data[SHOW_KEY] !== false;
    isPro = !!data.isPro;
    mount();
    new MutationObserver(onMutate).observe(document.body, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (F.FOLDERS_KEY in changes) state = F.normalize(changes[F.FOLDERS_KEY].newValue);
      if ("isPro" in changes) {
        isPro = !!changes.isPro.newValue;
        if (isPro) limitHit = false;
      }
      if (SHOW_KEY in changes) {
        enabled = changes[SHOW_KEY].newValue !== false;
        return mount();
      }
      render();
    });
  }

  start().catch(() => {});
})();
