(() => {
  "use strict";

  // On-page usage meter (v1.15, free for everyone): a small ring + percentage sitting right
  // beside claude.ai's model picker ("Opus 5.5 · Medium"), showing how much of
  // the 5-hour session limit is used. Click it for the weekly limit, per-model
  // buckets, and reset times. Warns once per window at 80 % and again at 100 %.
  //
  // Placement follows the Usage Meter extension (claude-usage-meter): append to
  // the model picker's parent row, and re-attach from a throttled
  // MutationObserver whenever React re-renders that row. No picker on the page
  // (settings, project list) means no meter — it never floats on its own.
  //
  // Also, for everyone: remembers which Claude org this tab is signed into, so
  // the side panel's meter and background backups read the account the user is
  // actually using rather than guessing.
  //
  // The chip and its panel live in shadow roots so claude.ai's CSS can't
  // restyle them and ours can't leak out. The chip's shadow root inherits the
  // picker row's font and colour, so it reads as part of Claude's own toolbar.
  if (window.__CPD_USAGE_PILL__) return;
  window.__CPD_USAGE_PILL__ = true;

  const U = window.ClaudeUsage;
  const API = window.ClaudeApi;
  if (!U || !API) return;

  const POLL_MS = 90 * 1000;
  const CHIP_ID = "cpd-usage-chip";
  const LAYER_ID = "cpd-usage-layer";
  const PICKER = '[data-testid="model-selector-dropdown"]';

  let orgId = API.parseOrgIdFromCookie(document.cookie);
  let enabled = false;
  let timer = null;
  let expanded = false;
  let toast = null;
  let toastTimer = null;
  let last = null;

  function rememberOrg() {
    const now = API.parseOrgIdFromCookie(document.cookie);
    if (now) orgId = now;
    if (orgId) chrome.storage.local.set({ lastOrgId: orgId }).catch(() => {});
  }

  function msg(key, fallback, subs) {
    try {
      const m = chrome.i18n.getMessage(key, subs);
      if (m) return m;
    } catch {
      /* extension reloaded underneath us */
    }
    if (!subs) return fallback;
    return [].concat(subs).reduce((s, v, i) => s.replace(`$${i + 1}`, v), fallback);
  }

  function isDark() {
    const html = document.documentElement;
    if (html.classList.contains("dark") || html.getAttribute("data-mode") === "dark") return true;
    if (html.classList.contains("light") || html.getAttribute("data-mode") === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function palette() {
    return isDark()
      ? "--bg:#262624;--fg:#f5f4ef;--mu:#a8a69e;--bd:#3a3a37;--track:#3a3a37;--hover:rgba(255,255,255,.07);--ok:#d97757;--warn:#e5a50a;--max:#e5484d;--toast:#b4381c;"
      : "--bg:#ffffff;--fg:#1f1e1d;--mu:#6b6a65;--bd:#e5e3dc;--track:#e8e6df;--hover:rgba(0,0,0,.05);--ok:#d97757;--warn:#d18b00;--max:#d93036;--toast:#b4381c;";
  }

  // ── The chip, inside the model picker's row ────────────────────────────────
  const CHIP_CSS = `
    :host { display: inline-flex; align-self: center; margin-left: 4px; font: inherit; color: inherit; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px;
      cursor: pointer; user-select: none; font-size: 12px; line-height: 1; color: inherit; opacity: .85;
      background: transparent; border: 0; font-family: inherit; }
    .chip:hover, .chip[aria-expanded="true"] { background: var(--hover); opacity: 1; }
    .chip:focus-visible { outline: 2px solid var(--ok); outline-offset: 1px; }
    .ring { width: 14px; height: 14px; flex: none; }
    .pct { font-weight: 500; font-variant-numeric: tabular-nums; }
    .warn { color: var(--warn); } .max { color: var(--max); }
  `;

  function ring(p, lvl) {
    const r = 5.5;
    const c = 2 * Math.PI * r;
    const color = lvl === "max" ? "var(--max)" : lvl === "warn" ? "var(--warn)" : "var(--ok)";
    const dash = ((p || 0) / 100) * c;
    return `<svg class="ring" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="${r}" fill="none" stroke="var(--track)" stroke-width="2.2"/>
      <circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round"
        stroke-dasharray="${dash} ${c}" transform="rotate(-90 7 7)"/></svg>`;
  }

  let chip = null; // { host, root }

  function findAnchor() {
    const picker = document.querySelector(PICKER);
    const row = picker ? picker.parentElement : null;
    // Our sister extension, Usage Meter for Claude, puts its own gauge (#cum-mini)
    // in this same row. Two meters side by side reads as a bug: defer to it.
    if (row && row.querySelector("#cum-mini")) return null;
    return row;
  }

  function removeChip() {
    if (chip) chip.host.remove();
    chip = null;
    closeLayer();
  }

  function ensureChip() {
    const anchor = findAnchor();
    if (!anchor) {
      removeChip();
      return null;
    }
    if (chip && chip.host.parentElement === anchor && chip.host.isConnected) return chip;
    if (chip) chip.host.remove();
    const host = document.createElement("span");
    host.id = CHIP_ID;
    const root = host.attachShadow({ mode: "closed" });
    anchor.appendChild(host);
    chip = { host, root };
    return chip;
  }

  function renderChip() {
    if (!enabled || !last || !last.session) return removeChip();
    const c = ensureChip();
    if (!c) return;
    const s = last.session;
    const lvl = U.level(s.pct);
    const resetIn = s.resetsAt ? U.formatResetIn(s.resetsAt) : "";
    const title = `${msg("usagePillTitle", "Claude usage — click for details")}${resetIn ? ` · ${msg("usageResetsIn", "resets in $1", resetIn)}` : ""}`;
    const html = `<style>${CHIP_CSS}</style><button class="chip" style="${palette()}" aria-expanded="${expanded}"
        title="${title.replace(/"/g, "&quot;")}">${ring(s.pct, lvl)}<span class="pct ${lvl === "ok" ? "" : lvl}">${s.pct}%</span></button>`;
    // Rewriting identical markup is itself a mutation our observer would see;
    // only touch the DOM when something changed.
    if (c.root.__html === html) return;
    c.root.__html = html;
    c.root.innerHTML = html;
    c.root.querySelector(".chip").addEventListener("click", (e) => {
      e.stopPropagation();
      expanded = !expanded;
      renderChip();
      renderLayer();
    });
  }

  // ── The panel and the warning toast, floating beside the chip ──────────────
  const LAYER_CSS = `
    :host { all: initial; }
    .box { position: fixed; z-index: 2147483000; width: 260px;
      font: 500 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .panel { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--bd); background: var(--bg);
      color: var(--fg); box-shadow: 0 8px 28px rgba(0,0,0,.18); }
    .row { margin: 0 0 10px; }
    .top { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .bar { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
    .bar i.warn { background: var(--warn); } .bar i.max { background: var(--max); }
    .muted { color: var(--mu); font-size: 11px; margin-top: 3px; }
    .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 4px;
      padding-top: 8px; border-top: 1px solid var(--bd); font-size: 11px; color: var(--mu); }
    button { all: unset; cursor: pointer; color: var(--mu); font-size: 11px; }
    button:hover { color: var(--fg); text-decoration: underline; }
    .chat { margin: 0 0 10px; padding-top: 8px; border-top: 1px solid var(--bd); }
    .chat .top b { font-variant-numeric: tabular-nums; }
    .toast { padding: 10px 12px; border-radius: 10px; background: var(--toast); color: #fff;
      box-shadow: 0 8px 28px rgba(0,0,0,.22); }
    .toast b { display: block; margin-bottom: 2px; }
  `;

  let layer = null; // { host, root }

  function closeLayer() {
    if (layer) layer.host.remove();
    layer = null;
  }

  function row(label, w) {
    if (!w) return "";
    const lvl = U.level(w.pct);
    const reset = w.resetsAt ? msg("usageResetsIn", "resets in $1", U.formatResetIn(w.resetsAt)) : "";
    return `<div class="row"><div class="top"><span>${label}</span><span>${w.pct}%</span></div>
      <div class="bar"><i class="${lvl}" style="width:${w.pct}%"></i></div><div class="muted">${reset}</div></div>`;
  }

  // Open toward whichever side has room: up from a composer docked at the
  // bottom of a chat, down from the centred composer on a new chat.
  function position(box) {
    const r = chip.host.getBoundingClientRect();
    const width = 260;
    box.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
    if (r.top > window.innerHeight / 2) {
      box.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
      box.style.top = "";
    } else {
      box.style.top = `${Math.round(r.bottom + 8)}px`;
      box.style.bottom = "";
    }
  }

  function renderLayer() {
    if (!chip || !chip.host.isConnected || (!expanded && !toast) || !last || !last.session) return closeLayer();
    if (!layer) {
      const host = document.createElement("div");
      host.id = LAYER_ID;
      layer = { host, root: host.attachShadow({ mode: "closed" }) };
      document.documentElement.appendChild(host);
    }
    const s = last.session;
    const resetIn = s.resetsAt ? U.formatResetIn(s.resetsAt) : "";
    const body = expanded
      ? `<div class="panel" role="dialog">
          ${row(msg("usageSession", "Current session (5-hour)"), last.session)}
          ${row(msg("usageWeekly", "Weekly limit"), last.weekly)}
          ${last.models.map((m) => row(msg("usageWeeklyModel", "Weekly · $1", m.label), m)).join("")}
          ${chatRow()}
          <div class="foot"><span>Claude Project Downloader</span>
            <button data-act="hide">${msg("usagePillHide", "Hide")}</button></div></div>`
      : `<div class="toast" role="status"><b>${toast.kind === "max"
          ? msg("usageToastMaxTitle", "Session limit reached")
          : msg("usageToastWarnTitle", "$1% of your session used", String(s.pct))}</b>${
          resetIn ? msg("usageToastResets", "Resets in $1.", resetIn) : ""}</div>`;
    layer.root.innerHTML = `<style>${LAYER_CSS}</style><div class="box" style="${palette()}">${body}</div>`;
    position(layer.root.querySelector(".box"));
    const hide = layer.root.querySelector('[data-act="hide"]');
    if (hide) hide.addEventListener("click", () => chrome.storage.local.set({ usagePill: false }));
  }

  // ── This chat ≈ N tokens (v1.16, from the Usage Meter extension) ─────────
  // Read when the panel opens on a chat, at most every 20 s per chat.
  let chatStats = null; // { id, at, size | null }

  function chatRow() {
    const id = API.parseChatIdFromPath(location.pathname);
    if (!id) return "";
    if (!chatStats || chatStats.id !== id || Date.now() - chatStats.at > 20000) loadChatStats(id);
    const size = chatStats && chatStats.id === id ? chatStats.size : null;
    const value = size ? `≈ ${U.formatCompact(size.tokens)}` : "…";
    const sub = size
      ? size.long
        ? msg("usageLongChat", "Long chat: every message re-sends all of it. A new chat stretches your limit.")
        : msg("usageChatMessages", "$1 messages · estimate", String(size.messages))
      : "";
    return `<div class="chat"><div class="top"><span>${msg("usageThisChat", "This chat's context")}</span><b>${value}</b></div>
      <div class="muted">${sub}</div></div>`;
  }

  async function loadChatStats(id) {
    chatStats = { id, at: Date.now(), size: chatStats && chatStats.id === id ? chatStats.size : null };
    if (!orgId || typeof window.transcriptToMarkdown !== "function") return;
    try {
      const t = await API.fetchTranscript(orgId, id);
      chatStats = { id, at: Date.now(), size: U.chatSize(t, window.transcriptToMarkdown) };
    } catch {
      return;
    }
    if (expanded) renderLayer();
  }

  function showToast(w) {
    toast = w;
    clearTimeout(toastTimer);
    renderLayer();
    toastTimer = setTimeout(() => {
      toast = null;
      renderLayer();
    }, 8000);
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function poll() {
    if (!enabled || document.visibilityState !== "visible") return;
    rememberOrg();
    if (!orgId) return;
    try {
      const res = await fetch(`/api/organizations/${orgId}/usage`, { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      last = U.parseUsage(await res.json());
    } catch {
      return;
    }
    renderChip();
    if (!last || !chip) return;
    try {
      const { usageWarnSeen } = await chrome.storage.local.get("usageWarnSeen");
      const w = U.warningFor(last.session, usageWarnSeen);
      if (w) {
        chrome.storage.local.set({ usageWarnSeen: w.seenKey });
        showToast(w);
      }
    } catch {
      /* extension reloaded */
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!enabled) {
      expanded = false;
      return removeChip();
    }
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  async function readSettings() {
    try {
      // Free for everyone and on by default (from 2026-10-04); the side panel
      // has the only switch.
      const { usagePill } = await chrome.storage.local.get("usagePill");
      enabled = usagePill !== false;
    } catch {
      enabled = false;
    }
    schedule();
  }

  // React re-renders the composer on navigation and while typing; put the chip
  // back whenever its row is rebuilt. Throttled so a burst of mutations costs
  // one check.
  let ensureQueued = false;
  new MutationObserver(() => {
    if (!enabled || ensureQueued) return;
    ensureQueued = true;
    setTimeout(() => {
      ensureQueued = false;
      if (!last) return;
      const had = chip && chip.host.isConnected;
      renderChip();
      if (!had && chip) poll(); // a new composer appeared: show a fresh reading
      if (layer) renderLayer();
    }, 150);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "usagePill" in changes) readSettings();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  window.addEventListener("resize", () => layer && renderLayer());
  // Close the panel on an outside click.
  document.addEventListener("click", (e) => {
    if (!expanded) return;
    const path = e.composedPath();
    if ((chip && path.includes(chip.host)) || (layer && path.includes(layer.host))) return;
    expanded = false;
    renderChip();
    renderLayer();
  });
  // A fresh reading shortly after a message is sent: that's when it moves.
  let lastSendPoll = 0;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey && Date.now() - lastSendPoll > 20000) {
        lastSendPoll = Date.now();
        setTimeout(poll, 15000);
      }
    },
    true
  );

  rememberOrg();
  readSettings();
})();
