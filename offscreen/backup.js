// offscreen/backup.js — runs lib/backup-engine.js for background.js.
//
// An offscreen document is an extension page: it fetches claude.ai with the
// browser's signed-in cookies exactly like the popup does, can build a Blob,
// and outlives both the popup and the service worker's idle timeout. It cannot
// call chrome.downloads, so it hands the finished ZIP's blob URL back to
// background.js, which downloads it and then closes this page.
"use strict";

const ORIGIN = "https://claude.ai";
let cancelled = false;
let running = false;

function send(message) {
  chrome.runtime.sendMessage({ ...message, from: "offscreen" }).catch(() => {});
}

async function getJson(url) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return getJson(url);
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getBlob(url) {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function resolveOrg(rememberedOrgId) {
  const orgs = await getJson(`${ORIGIN}/api/organizations`);
  return self.ClaudeUsage.pickOrg(orgs, rememberedOrgId);
}

async function run({ orgId: remembered, projectIds, includeLooseChats, chatFormat }) {
  if (running) return;
  running = true;
  cancelled = false;
  try {
    let orgId;
    try {
      orgId = await resolveOrg(remembered);
    } catch (err) {
      const signedOut = err.status === 401 || err.status === 403;
      throw Object.assign(new Error(signedOut ? "Sign in to claude.ai, then try again." : err.message), {
        code: signedOut ? "signed_out" : "network",
      });
    }
    if (!orgId) throw Object.assign(new Error("No Claude account found. Sign in to claude.ai."), { code: "signed_out" });

    const zip = new self.TinyZip();
    let lastSent = 0;
    const { folder, stats } = await self.BackupEngine.runBackup(
      {
        getJson,
        getBlob,
        zip,
        format: {
          transcriptToMarkdown: self.transcriptToMarkdown,
          transcriptToJson: self.transcriptToJson,
          sanitizeChatFilename: self.sanitizeChatFilename,
          buildInstructionsMarkdown: self.buildInstructionsMarkdown,
          isLossyDoc: self.isLossyDoc,
          toTxtName: self.toTxtName,
        },
        isCancelled: () => cancelled,
        onProgress: (p) => {
          // At most ~4 updates a second: each one is a storage write upstream.
          const now = Date.now();
          if (now - lastSent < 250 && p.done !== p.total) return;
          lastSent = now;
          send({ type: "BACKUP_PROGRESS", ...p });
        },
      },
      { orgId, projectIds: Array.isArray(projectIds) ? projectIds : null, includeLooseChats: includeLooseChats !== false, chatFormat }
    );
    send({ type: "BACKUP_PROGRESS", phase: "zipping", done: 0, total: 0, label: "Building ZIP…" });
    const blob = await zip.generateBlob();
    send({
      type: "BACKUP_READY",
      url: URL.createObjectURL(blob),
      folder,
      bytes: blob.size,
      stats: {
        projects: stats.projects,
        files: stats.files,
        chats: stats.chats + stats.looseChats,
        failed: stats.failedFiles.length + stats.failedChats.length + stats.failedProjects.length,
      },
      orgId,
    });
  } catch (err) {
    send({ type: "BACKUP_FAILED", code: err.code || (err.status === 401 || err.status === 403 ? "signed_out" : "error"), error: err.message });
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "offscreen") return;
  if (message.type === "RUN_BACKUP") run(message.options || {});
  if (message.type === "CANCEL_BACKUP") cancelled = true;
});

send({ type: "OFFSCREEN_READY" });
