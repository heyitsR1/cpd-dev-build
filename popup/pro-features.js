// pro-features.js — the v1.15 popup cards: Claude usage limits, "Back up
// everything", and the plan line (lifetime / monthly / ended).
//
// Kept out of popup.js, which is already the project-export screen. popup.js
// calls initProFeatures once, handing over the upgrade modal it owns.

import { checkLicense, getUpgradeUrl, getManageUrl } from "./licensing.js";

const U = window.ClaudeUsage;
const ORIGIN = "https://claude.ai";

let deps = { openProModal: () => {} };
let isPro = false;

const $ = (id) => document.getElementById(id);

// Localised string with $1… substitutions, English fallback.
function fmt(key, fallback, subs) {
  const list = subs == null ? undefined : [].concat(subs).map(String);
  if (window.i18n) return window.i18n.t(key, list, fallback);
  return (list || []).reduce((out, v, i) => out.replace(`$${i + 1}`, v), fallback);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function dateLabel(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return new Date(ms).toDateString();
  }
}

function dateTimeLabel(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return new Date(ms).toString();
  }
}

// ── Usage ────────────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function resolveOrg() {
  const { lastOrgId } = await chrome.storage.local.get("lastOrgId");
  if (lastOrgId) return lastOrgId;
  const orgs = await getJson(`${ORIGIN}/api/organizations`);
  const id = U.pickOrg(orgs, null);
  if (id) chrome.storage.local.set({ lastOrgId: id });
  return id;
}

function usageRow(label, w) {
  if (!w) return "";
  const lvl = U.level(w.pct);
  const reset = w.resetsAt ? fmt("usageResetsIn", "resets in $1", U.formatResetIn(w.resetsAt)) : "";
  return `<div class="usage-row">
    <div class="usage-row__top"><span>${escapeHtml(label)} · <strong>${w.pct}%</strong></span><span>${escapeHtml(reset)}</span></div>
    <div class="usage-bar"><i class="${lvl}" style="width:${w.pct}%"></i></div>
  </div>`;
}

async function loadUsage() {
  const card = $("usageCard");
  const rows = $("usageRows");
  if (!card || !U) return;
  card.hidden = false;
  let usage = null;
  let signedOut = false;
  try {
    const orgId = await resolveOrg();
    if (orgId) {
      try {
        usage = U.parseUsage(await getJson(`${ORIGIN}/api/organizations/${orgId}/usage`));
      } catch (err) {
        // A remembered org the account no longer belongs to: forget it once.
        if (err.status === 403 || err.status === 404) {
          await chrome.storage.local.remove("lastOrgId");
          const fresh = await resolveOrg();
          if (fresh && fresh !== orgId) usage = U.parseUsage(await getJson(`${ORIGIN}/api/organizations/${fresh}/usage`));
        } else throw err;
      }
    }
  } catch (err) {
    signedOut = err && (err.status === 401 || err.status === 403);
  }
  if (!usage) {
    rows.innerHTML = `<p class="usage-card__empty">${escapeHtml(
      signedOut
        ? fmt("usageSignedOut", "Sign in to claude.ai to see your limits.")
        : fmt("usageUnavailable", "Couldn't read your limits right now. Open claude.ai and try again.")
    )}</p>`;
    return;
  }
  rows.innerHTML =
    usageRow(fmt("usageSessionShort", "5-hour session"), usage.session) +
    usageRow(fmt("usageWeeklyShort", "Weekly"), usage.weekly) +
    usage.models.map((m) => usageRow(fmt("usageWeeklyModel", "Weekly · $1", m.label), m)).join("");
}

async function initUsageToggle() {
  const toggle = $("usagePillToggle");
  if (!toggle) return;
  // Free for everyone, on unless switched off.
  const { usagePill } = await chrome.storage.local.get("usagePill");
  toggle.checked = usagePill !== false;
  toggle.onchange = () => chrome.storage.local.set({ usagePill: toggle.checked });
}

// ── Backups ──────────────────────────────────────────────────────────────────

function renderBackup(state) {
  const { backupRun: run, lastBackup, lastBackupError, backupSettings } = state;
  const card = $("backupCard");
  const nowBtn = $("backupNowBtn");
  const select = $("backupScheduleSelect");
  const progress = $("backupProgress");
  const status = $("backupStatus");
  if (!card) return;

  card.classList.toggle("backup-card--locked", !isPro);
  select.value = (isPro && backupSettings && backupSettings.schedule) || "off";

  const live = run && run.running && Date.now() - (run.startedAt || 0) < 2 * 60 * 60 * 1000;
  nowBtn.disabled = !!live;
  progress.hidden = !live;
  if (live) {
    const total = run.total || 0;
    const done = Math.min(run.done || 0, total);
    $("backupProgressLabel").textContent =
      run.phase === "export"
        ? fmt("backupExporting", "Exporting $1", run.label || "…")
        : run.label || fmt("backupStarting", "Starting…");
    const bar = $("backupProgressBar");
    if (total > 0) {
      bar.max = total;
      bar.value = done;
      $("backupProgressText").textContent = `${done} / ${total}`;
    } else {
      bar.removeAttribute("value");
      $("backupProgressText").textContent = "";
    }
  }

  status.classList.remove("backup-card__status--err");
  if (!isPro) {
    status.textContent = fmt("backupProOnly", "Pro feature. Your files land in Downloads › Claude Backups.");
  } else if (live) {
    status.textContent = fmt("backupKeepGoing", "You can close this panel — the backup keeps going.");
  } else if (lastBackupError && (!lastBackup || lastBackupError.at > lastBackup.at)) {
    status.classList.add("backup-card__status--err");
    status.textContent =
      lastBackupError.code === "signed_out"
        ? fmt("backupSignedOut", "Last backup failed: sign in to claude.ai, then try again.")
        : fmt("backupFailed", "Last backup failed: $1", lastBackupError.error || "unknown error");
  } else if (lastBackup && lastBackup.at) {
    const st = lastBackup.stats || {};
    status.textContent = fmt(
      "backupLast",
      "Last backup $1 · $2 projects, $3 chats · Downloads › Claude Backups",
      [dateTimeLabel(lastBackup.at), String(st.projects ?? 0), String(st.chats ?? 0)]
    );
  } else {
    status.textContent = fmt("backupNever", "No backup yet. Saved to Downloads › Claude Backups.");
  }
}

async function refreshBackup() {
  renderBackup(await chrome.storage.local.get(["backupRun", "lastBackup", "lastBackupError", "backupSettings"]));
}

function initBackup() {
  const nowBtn = $("backupNowBtn");
  const select = $("backupScheduleSelect");
  if (!nowBtn) return;

  nowBtn.onclick = async () => {
    if (!isPro) return deps.openProModal("backup");
    nowBtn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: "BACKUP_START" }).catch(() => null);
    if (!res || !res.ok) {
      if (res && res.error === "not_pro") deps.openProModal("backup");
      if (res && res.error === "nothing_selected") {
        const status = $("backupStatus");
        status.classList.add("backup-card__status--err");
        status.textContent = fmt("backupNeedOne", "Pick at least one project, or tick chats outside projects.");
      }
      nowBtn.disabled = false;
      return;
    }
    refreshBackup();
  };

  select.onchange = async () => {
    if (!isPro) {
      select.value = "off";
      return deps.openProModal("backup");
    }
    const { backupSettings } = await chrome.storage.local.get("backupSettings");
    await chrome.storage.local.set({ backupSettings: { ...(backupSettings || {}), schedule: select.value } });
  };

  $("backupCancelBtn").onclick = () => chrome.runtime.sendMessage({ type: "BACKUP_CANCEL" }).catch(() => {});
  initBackupScope();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("backupRun" in changes || "lastBackup" in changes || "lastBackupError" in changes) refreshBackup();
  });
  refreshBackup();
}

// ── Backup scope ─────────────────────────────────────────────────────────────
// "All projects" (default) or a hand-picked set. Stored in backupSettings and
// read by background.js for both "Back up now" and scheduled runs.

async function saveBackupSettings(patch) {
  const { backupSettings } = await chrome.storage.local.get("backupSettings");
  await chrome.storage.local.set({ backupSettings: { ...(backupSettings || {}), ...patch } });
}

async function loadProjectChoices() {
  const list = $("backupProjectList");
  list.innerHTML = `<p class="usage-card__empty">${escapeHtml(fmt("backupLoadingProjects", "Loading your projects…"))}</p>`;
  let projects = [];
  try {
    const orgId = await resolveOrg();
    projects = await getJson(`${ORIGIN}/api/organizations/${orgId}/projects`);
    if (!Array.isArray(projects)) projects = (projects && projects.data) || [];
  } catch {
    list.innerHTML = `<p class="usage-card__empty">${escapeHtml(fmt("backupSignIn", "Sign in to claude.ai to list your projects."))}</p>`;
    return;
  }
  const { backupSettings } = await chrome.storage.local.get("backupSettings");
  const picked = new Set((backupSettings && backupSettings.projectIds) || []);
  projects.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  list.innerHTML = projects
    .map(
      (p) => `<label class="backup-card__check" title="${escapeHtml(p.name || "")}">
        <input type="checkbox" value="${escapeHtml(p.uuid)}" ${picked.has(p.uuid) ? "checked" : ""} />
        <span>${escapeHtml(p.name || "Untitled project")}</span></label>`
    )
    .join("") || `<p class="usage-card__empty">${escapeHtml(fmt("backupNoProjects", "No projects in this account yet."))}</p>`;
  list.onchange = () => {
    const ids = [...list.querySelectorAll("input:checked")].map((i) => i.value);
    saveBackupSettings({ projectIds: ids });
  };
}

async function initBackupScope() {
  const select = $("backupScopeSelect");
  const picker = $("backupProjectPicker");
  const loose = $("backupLooseChats");
  if (!select) return;
  const { backupSettings } = await chrome.storage.local.get("backupSettings");
  const st = backupSettings || {};
  select.value = st.scope === "selected" ? "selected" : "all";
  loose.checked = st.includeLooseChats !== false;
  const show = () => {
    picker.hidden = select.value !== "selected";
    if (!picker.hidden) loadProjectChoices();
  };
  select.onchange = async () => {
    if (!isPro) {
      select.value = "all";
      return deps.openProModal("backup");
    }
    await saveBackupSettings({ scope: select.value });
    show();
  };
  loose.onchange = () => saveBackupSettings({ includeLooseChats: loose.checked });
  show();
}

// ── Plan line (the limit card) ───────────────────────────────────────────────

/**
 * The limit card's content for a Pro or lapsed licence. Returns null for a
 * free install that never had one, so popup.js keeps its own free-tier copy.
 */
export async function planCardContent() {
  const lic = await checkLicense();
  if (lic.isPro) {
    const monthly = lic.tier === "monthly" || lic.tier === "annual";
    const renew = lic.expiresAt ? ` · ↻ ${dateLabel(lic.expiresAt)}` : "";
    // The card is one line in the side panel, so the renewal date rides in it.
    const main =
      lic.tier === "annual"
        ? `${fmt("planYearly", "Yearly")}${renew}`
        : monthly
          ? `${fmt("planMonthly", "Monthly")}${renew}`
          : fmt("planLifetime", "Lifetime");
    const sub = monthly && lic.expiresAt
      ? fmt("planRenews", "Renews $1. Unlimited exports, backups, and the on-page usage meter.", dateLabel(lic.expiresAt))
      : fmt("planProSub", "Unlimited exports, backups, and the on-page usage meter.");
    return {
      html:
        `<span class="limit-main"><span class="supporter-badge">PRO</span> &nbsp;${escapeHtml(main)}</span>` +
        `<span class="limit-sub">${escapeHtml(sub)}</span>`,
      // Monthly: say "cancel" out loud — a hidden cancel button is how
      // subscriptions earn chargebacks and store complaints.
      link: monthly ? fmt("planManageCancel", "Manage / cancel ↗") : fmt("manageLicense", "Manage License"),
      action: "manage",
      url: getManageUrl(lic.tier),
      // Subscribers get a standing offer to pay once instead. Lifetime owners
      // have nothing left to buy, so they see none.
      upsell: monthly ? fmt("planGetLifetime", "Get Lifetime") : null,
    };
  }
  if (lic.licenseKey && (lic.status === "expired" || lic.status === "cancelled")) {
    const ended = lic.status === "expired";
    return {
      html:
        `<span class="limit-main">${escapeHtml(
          ended ? fmt("planEnded", "Your Pro subscription has ended") : fmt("planCancelled", "This Pro license was cancelled")
        )}</span>` +
        `<span class="limit-sub limit-sub--warn">${escapeHtml(
          fmt("planEndedSub", "You're on the free plan again. Your past exports and backups are still yours.")
        )}</span>`,
      link: ended ? fmt("planRenew", "Renew Pro") : fmt("upgradeLink", "Upgrade to Pro"),
      action: "renew",
    };
  }
  return null;
}

export function openUpgrade(hit) {
  chrome.tabs.create({ url: getUpgradeUrl(hit) });
}

// ── Init ─────────────────────────────────────────────────────────────────────

function initFooter() {
  const mode = $("uiModeSelect");
  if (mode) {
    const popup = new URLSearchParams(location.search).get("mode") === "popup";
    mode.value = popup ? "popup" : "panel";
    // Looked up now: chrome.sidePanel.open only works inside the user's click,
    // and an await before it would spend that.
    let windowId = null;
    chrome.windows.getCurrent().then((w) => (windowId = w.id), () => {});
    mode.onchange = () => {
      if (mode.value === "panel" && windowId != null) {
        chrome.sidePanel.open({ windowId }).catch(() => {});
      }
      chrome.storage.local.set({ uiMode: mode.value }).then(() => {
        if (mode.value === "panel" && popup) window.close();
      });
    };
  }
}

export async function initProFeatures(options) {
  deps = { ...deps, ...options };
  isPro = (await checkLicense()).isPro;
  if (new URLSearchParams(location.search).get("mode") === "popup") {
    document.documentElement.classList.add("is-popup");
    // The Library tab stays inside the fixed-size popup too.
    const lib = $("tabLibrary");
    if (lib) lib.href = "../library/library.html?mode=popup";
  }
  initFooter();

  const footer = $("footerVersion");
  if (footer) footer.textContent = `v${chrome.runtime.getManifest().version} · Claude Project Downloader`;

  initBackup();
  initUsageToggle();
  const refresh = $("usageRefreshBtn");
  if (refresh) refresh.onclick = () => loadUsage();
  loadUsage();

  // Ask the worker to re-check the licence if it's due (a lapsed subscription,
  // or a day since the last answer). Cheap when not due; repaint if it changed.
  chrome.runtime
    .sendMessage({ type: "LICENSE_REVALIDATE" })
    .then(async (res) => {
      if (res && res.changed) {
        isPro = (await checkLicense()).isPro;
        initUsageToggle();
        refreshBackup();
        if (deps.onLicenseChanged) deps.onLicenseChanged();
      }
    })
    .catch(() => {});
}
