// background.js — Service worker for Claude Project Downloader (ES module).
//
// Since v1.15 it also owns three jobs that must outlive the popup:
//   1. Licence revalidation — a subscription has to stop when it stops being
//      paid for. See revalidateLicense in popup/licensing.js.
//   2. "Back up everything", on demand and on a schedule. The work happens in
//      an offscreen document (offscreen/backup.js); this file starts it, keeps
//      its progress in storage for the popup, downloads the finished ZIP, and
//      closes it.
//   3. Free-tier bookkeeping for bulk exports: the one free export is spent
//      when its file is actually saved, not when the save is merely started.

import { checkLicense, revalidateLicense, getUpgradeUrl, activateLicense } from "./popup/licensing.js";
import { autoBackupDue, isRunLive } from "./popup/backup-schedule.js";

// v1.15: the toolbar icon opens Chrome's side panel instead of a popup. The
// panel has room for everything (export, backups, limits), stays open while
// a long export runs, and doesn't vanish when the Save dialog takes focus.
//
// Chrome decides the side panel's width (one width shared by every panel), so
// users who find it too wide can switch to the fixed-width popup instead.
// Storage: uiMode "panel" (default) | "popup".
async function applyUiMode() {
  const { uiMode } = await chrome.storage.local.get("uiMode");
  const popup = uiMode === "popup";
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !popup }).catch(() => {});
  await chrome.action.setPopup({ popup: popup ? "popup/popup.html?mode=popup" : "" });
}
applyUiMode();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "uiMode" in changes) applyUiMode();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "onboarding.html" });
  }
  ensureAlarms();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  revalidateLicense().catch(() => {});
});

// Reuse the same install_uid the popup's licensing module creates (32-char hex),
// so uninstall feedback can be tied back to a known install. Generate one here if
// the user never opened the popup before uninstalling.
async function getInstallUid() {
  const { install_uid } = await chrome.storage.local.get(["install_uid"]);
  if (install_uid && install_uid.length === 32) return install_uid;
  const array = new Uint32Array(4);
  crypto.getRandomValues(array);
  const uid = Array.from(array, (n) => n.toString(16).padStart(8, "0")).join("");
  await chrome.storage.local.set({ install_uid: uid });
  return uid;
}

// Point uninstalls at our own exit survey (learn why people leave + offer a
// one-time retention discount). Append version + install id so feedback has context.
(async () => {
  const base = "https://claudeprojectdownloader.com/uninstall";
  try {
    const version = chrome.runtime.getManifest().version;
    const installId = await getInstallUid();
    chrome.runtime.setUninstallURL(
      `${base}?v=${encodeURIComponent(version)}&id=${encodeURIComponent(installId)}`
    );
  } catch {
    chrome.runtime.setUninstallURL(base);
  }
})();

// ── Alarms ───────────────────────────────────────────────────────────────────
const REVALIDATE_ALARM = "revalidate";
const BACKUP_ALARM = "auto-backup";

async function ensureAlarms() {
  if (!(await chrome.alarms.get(REVALIDATE_ALARM))) {
    chrome.alarms.create(REVALIDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  }
  if (!(await chrome.alarms.get(BACKUP_ALARM))) {
    chrome.alarms.create(BACKUP_ALARM, { delayInMinutes: 5, periodInMinutes: 60 });
  }
}
ensureAlarms();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REVALIDATE_ALARM) revalidateLicense().catch(() => {});
  if (alarm.name === BACKUP_ALARM) maybeAutoBackup().catch(() => {});
});

// ── Backups ──────────────────────────────────────────────────────────────────
// Storage: backupSettings { schedule: "off"|"daily"|"weekly", scope: "all"|"selected",
//                          projectIds: string[], includeLooseChats }
//          backupRun      { running, trigger, startedAt, phase, done, total, label }
//          lastBackup     { at, folder, bytes, stats, downloadId }
//          lastBackupError{ at, code, error }
const OFFSCREEN_URL = "offscreen/backup.html";
async function maybeAutoBackup() {
  const { isPro } = await checkLicense();
  if (!isPro) return;
  const s = await chrome.storage.local.get(["backupSettings", "lastBackup", "lastBackupError", "backupRun"]);
  if (!autoBackupDue({ settings: s.backupSettings, lastBackup: s.lastBackup, lastBackupError: s.lastBackupError, run: s.backupRun })) return;
  await startBackup("auto");
}

async function setRun(patch) {
  const { backupRun } = await chrome.storage.local.get("backupRun");
  await chrome.storage.local.set({ backupRun: { ...(backupRun || {}), ...patch } });
}

async function startBackup(trigger) {
  const { isPro } = await checkLicense();
  if (!isPro) return { ok: false, error: "not_pro" };
  const { backupRun, backupSettings, lastOrgId } = await chrome.storage.local.get(["backupRun", "backupSettings", "lastOrgId"]);
  if (isRunLive(backupRun)) return { ok: false, error: "busy" };
  const chosen = backupSettings && backupSettings.scope === "selected";
  if (chosen && !(backupSettings.projectIds || []).length && backupSettings.includeLooseChats === false) {
    return { ok: false, error: "nothing_selected" };
  }
  await chrome.storage.local.set({
    backupRun: { running: true, trigger, startedAt: Date.now(), phase: "listing", done: 0, total: 0, label: "Starting…" },
  });
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "RUN_BACKUP",
      options: {
        orgId: lastOrgId || null,
        // "all" (default) or "selected": only the projects the user ticked.
        projectIds:
          backupSettings && backupSettings.scope === "selected" ? backupSettings.projectIds || [] : null,
        includeLooseChats: !backupSettings || backupSettings.includeLooseChats !== false,
        chatFormat: "markdown",
      },
    });
  } catch (err) {
    await finishWithError("error", err && err.message ? err.message : "Could not start the backup.");
    return { ok: false, error: "start_failed" };
  }
  return { ok: true };
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"],
    justification: "Build a backup ZIP of the user's own Claude projects and chats.",
  });
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

async function finishWithError(code, error) {
  // A cancel is the user's choice, not a failure: it must not hold off the
  // next scheduled run the way a signed-out or offline failure does.
  if (code !== "cancelled") await chrome.storage.local.set({ lastBackupError: { at: Date.now(), code, error } });
  await setRun({ running: false, phase: code === "cancelled" ? "cancelled" : "failed", label: error });
  await closeOffscreen();
}

// Downloads this worker started for a backup: id → { folder, bytes, stats }.
// Kept in storage because the worker can be shut down while Chrome writes a
// large file.
async function onBackupReady(msg) {
  const filename = `Claude Backups/${msg.folder}.zip`;
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: msg.url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (err) {
    await finishWithError("download", err && err.message ? err.message : "Download failed.");
    return;
  }
  const { pendingBackupDownloads = {} } = await chrome.storage.local.get("pendingBackupDownloads");
  pendingBackupDownloads[downloadId] = { folder: msg.folder, bytes: msg.bytes, stats: msg.stats, orgId: msg.orgId };
  await chrome.storage.local.set({ pendingBackupDownloads });
  await setRun({ phase: "saving", label: "Saving…" });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || (delta.state.current !== "complete" && delta.state.current !== "interrupted")) return;
  const ok = delta.state.current === "complete";
  const s = await chrome.storage.local.get(["pendingBackupDownloads", "pendingBulkDownloads"]);

  // A backup ZIP finishing.
  const backups = s.pendingBackupDownloads || {};
  const backup = backups[delta.id];
  if (backup) {
    delete backups[delta.id];
    await chrome.storage.local.set({ pendingBackupDownloads: backups });
    if (ok) {
      await chrome.storage.local.set({
        lastBackup: { at: Date.now(), folder: backup.folder, bytes: backup.bytes, stats: backup.stats, downloadId: delta.id },
        lastBackupError: null,
      });
      await setRun({ running: false, phase: "done", label: "Backup saved." });
      await closeOffscreen();
    } else {
      await finishWithError("download", "The backup download was interrupted.");
    }
    return;
  }

  // A free user's one bulk export: spent only once the file is on disk.
  const bulk = s.pendingBulkDownloads || [];
  if (bulk.includes(delta.id)) {
    const patch = { pendingBulkDownloads: bulk.filter((id) => id !== delta.id) };
    if (ok) patch.bulkTasteUsed = true;
    await chrome.storage.local.set(patch);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.from === "offscreen") {
    if (msg.type === "BACKUP_PROGRESS") {
      setRun({ phase: msg.phase, done: msg.done, total: msg.total, label: msg.label });
    } else if (msg.type === "BACKUP_READY") {
      onBackupReady(msg);
    } else if (msg.type === "BACKUP_FAILED") {
      finishWithError(msg.code || "error", msg.error || "Backup failed.");
    }
    return;
  }

  if (msg.type === "BACKUP_START") {
    startBackup("manual").then(sendResponse);
    return true;
  }
  if (msg.type === "BACKUP_CANCEL") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "CANCEL_BACKUP" }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  // From the Folders section in claude.ai's sidebar (content/sidebar-folders.js).
  if (msg.type === "OPEN_UPGRADE") {
    chrome.tabs.create({ url: getUpgradeUrl(msg.hit) });
    return;
  }
  // "Save as PDF" from the in-page Download button (content/chat-button.js):
  // content scripts can't open extension tabs themselves.
  if (msg.type === "OPEN_PDF" && typeof msg.query === "string") {
    chrome.tabs.create({ url: chrome.runtime.getURL(`print/print.html?${msg.query}`) });
    return;
  }
  if (msg.type === "OPEN_LIBRARY") {
    chrome.tabs.create({ url: chrome.runtime.getURL("library/library.html?tab=1") });
    return;
  }
  if (msg.type === "LICENSE_REVALIDATE") {
    revalidateLicense({ force: !!msg.force }).then(sendResponse, () => sendResponse({ checked: false }));
    return true;
  }
});

// Instant activation (v1.19): claudeprojectdownloader.com/thanks hands over the
// buyer's real licence key, read from Freemius's signed redirect by the Worker
// (POST /purchase-key). We activate it exactly as if it were pasted, then flag
// a "save your key" notice in the side panel: Pro is on here, but the buyer
// still needs the key for another browser or a reinstall.
// Only our own site can reach this (manifest externally_connectable).
const ACTIVATE_ORIGIN = "https://claudeprojectdownloader.com";
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (sender.origin !== ACTIVATE_ORIGIN || !msg) return;
  if (msg.type === "CPD_PING") {
    checkLicense().then(({ isPro }) => sendResponse({ ok: true, version: chrome.runtime.getManifest().version, isPro }));
    return true;
  }
  if (msg.type !== "CPD_ACTIVATE" || typeof msg.key !== "string" || !/^[A-Za-z0-9_\-:.]{8,64}$/.test(msg.key)) return;
  (async () => {
    const current = await checkLicense();
    if (current.isPro && current.licenseKey === msg.key) return sendResponse({ ok: true, already: true });
    const result = await activateLicense(msg.key);
    if (result.ok) await chrome.storage.local.set({ keyNoticePending: true });
    sendResponse(result.ok ? { ok: true } : { ok: false, error: result.error });
  })();
  return true;
});
