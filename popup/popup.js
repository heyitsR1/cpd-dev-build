"use strict";

import {
  checkLicense,
  activateLicense,
  getRemainingDownloads,
  canDownloadSingle,
  recordDownload,
  canBulkDownload,
  recordBulkDownload,
  getBulkTasteUsed,
  getUpgradeUrl,
  getLifetimeUpgradeUrl,
  FREE_DAILY_DOWNLOADS,
} from "./licensing.js";
import { initProFeatures, planCardContent } from "./pro-features.js";
import { initReport, noteError } from "../lib/report.js";
import { summarizeContext, renderContextMeter } from "./context-meter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Content-script messaging (self-healing)
// ─────────────────────────────────────────────────────────────────────────────
// The content script is injected declaratively at page load. If the tab was
// already open when the extension was installed or updated, that tab has no
// live content script and every sendMessage fails with "Receiving end does not
// exist" / "message port closed". We fix this by (re)injecting the script on
// demand via chrome.scripting before messaging — the script guards against
// double-registration, so injecting when it's already there is a no-op.

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // Keep in step with manifest.json's claude.ai content_scripts entry —
      // content.js and chat-button.js both read window.ClaudeApi.
      files: [
        "lib/zip.js",
        "lib/chat-format.js",
        "lib/claude-api.js",
        "lib/i18n.js",
        "lib/usage.js",
        "lib/folders.js",
        "content/content.js",
        "content/chat-button.js",
        "content/usage-pill.js",
        "content/sidebar-folders.js",
        "lib/context-plan.js",
        "content/context-select.js",
      ],
    });
  } catch (e) {
    // Restricted page or missing host permission — let sendMessage surface it.
    console.warn("[Claude DL] Could not inject content script:", e);
  }
}

function rawSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// Message the content script, injecting it first so a stale tab still works.
// Retries once after a fresh injection if the receiver still isn't there.
async function sendToTab(tabId, message) {
  await ensureContentScript(tabId);
  try {
    return await rawSendMessage(tabId, message);
  } catch (err) {
    const msg = err && err.message ? err.message : "";
    if (
      /Receiving end does not exist|Could not establish connection|message port closed|context invalidated/i.test(
        msg
      )
    ) {
      await ensureContentScript(tabId);
      return await rawSendMessage(tabId, message);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────
const statusPill = document.getElementById("statusPill");
const contextLabel = document.getElementById("contextLabel");
const projectText = document.getElementById("projectText");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const progressText = document.getElementById("progressText");

const refreshBtn = document.getElementById("refreshBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const formatSelect = document.getElementById("formatSelect");
const archiveNameInput = document.getElementById("archiveName");
const downloadChatsBtn = document.getElementById("downloadChatsBtn");
const downloadProjectBtn = document.getElementById("downloadProjectBtn");
const chatFormatSelect = document.getElementById("chatFormatSelect");
const includeAttachmentsCheckbox = document.getElementById("includeAttachmentsCheckbox");

const singleChatCard = document.getElementById("singleChatCard");
const singleChatTitle = document.getElementById("singleChatTitle");
const singleChatMeta = document.getElementById("singleChatMeta");
const singleChatFormatSelect = document.getElementById("singleChatFormatSelect");
const downloadSingleChatBtn = document.getElementById("downloadSingleChatBtn");
const projectControlsGroup = document.getElementById("projectControlsGroup");
const filesSection = document.getElementById("filesSection");
const chatsSection = document.getElementById("chatsSection");

const fileListContainer = document.getElementById("fileListContainer");
const countPill = document.getElementById("countPill");
const chatListContainer = document.getElementById("chatListContainer");
const chatCountPill = document.getElementById("chatCountPill");

const howToBtn = document.getElementById("howToBtn");
const howToModal = document.getElementById("howToModal");
const closeHowToBtn = document.getElementById("closeHowToBtn");
const howToBackdrop = document.getElementById("howToBackdrop");
const modalTutorialLink = document.getElementById("modalTutorialLink");

const troubleshootModal = document.getElementById("troubleshootModal");
const closeTroubleshootBtn = document.getElementById("closeTroubleshootBtn");
const troubleshootBackdrop = document.getElementById("troubleshootBackdrop");

const fallbackModal = document.getElementById("fallbackModal");
const closeFallbackBtn = document.getElementById("closeFallbackBtn");
const fallbackBackdrop = document.getElementById("fallbackBackdrop");
const copyFallbackBtn = document.getElementById("copyFallbackBtn");
const fallbackPromptText = document.getElementById("fallbackPromptText");
const lossyBulkModal = document.getElementById("lossyBulkModal");
const lossyBulkBackdrop = document.getElementById("lossyBulkBackdrop");
const closeLossyBulkBtn = document.getElementById("closeLossyBulkBtn");
const lossyBulkList = document.getElementById("lossyBulkList");
const lossyBulkTxtBtn = document.getElementById("lossyBulkTxtBtn");
const lossyBulkAskBtn = document.getElementById("lossyBulkAskBtn");
const lossySingleModal = document.getElementById("lossySingleModal");
const lossySingleBackdrop = document.getElementById("lossySingleBackdrop");
const closeLossySingleBtn = document.getElementById("closeLossySingleBtn");
const lossySingleName = document.getElementById("lossySingleName");
const lossySingleTxtBtn = document.getElementById("lossySingleTxtBtn");
const lossySingleAskBtn = document.getElementById("lossySingleAskBtn");
const statusHint = document.getElementById("statusHint");

// Support & Limit Card DOM refs
const supportModal = document.getElementById("supportModal");
const closeSupportBtn = document.getElementById("closeSupportBtn");
const supportBackdrop = document.getElementById("supportBackdrop");
const supportCheckoutBtn = document.getElementById("supportCheckoutBtn");
const supportLicenseInput = document.getElementById("supportLicenseInput");
const supportActivateBtn = document.getElementById("supportActivateBtn");
const supportStatusMsg = document.getElementById("supportStatusMsg");
const supportIntro = document.getElementById("supportIntro");

// Upgrade copy per reason the modal opened. Restored on every open so the
// message never gets stuck on a previous reason's variant.
const PRO_INTROS = {
  daily: [
    "proIntroDaily",
    `That's your ${FREE_DAILY_DOWNLOADS} free downloads for today. Pro removes the daily limit — unlimited single downloads and unlimited full project exports.`,
  ],
  bulk: [
    "proIntroBulk",
    "You've used your free full project export. Pro unlocks unlimited full exports — every chat and file in one click, whenever you like.",
  ],
  backup: [
    "proIntroBackup",
    "Back up everything is a Pro feature: every project's instructions, files, and chats, plus all your other chats, in one ZIP — on demand or automatically every day or week.",
  ],
  usage: [
    "proIntroUsage",
    "The on-page meter is a Pro feature: your 5-hour and weekly Claude limits in the corner of claude.ai, with a heads-up at 80% and 100%.",
  ],
  renew: [
    "proIntroRenew",
    "Your Pro subscription has ended. Renew to switch unlimited exports, backups, and the on-page meter back on. Your key stays the same.",
  ],
};

// Localised string with an English fallback, for text built here rather than
// marked up with data-i18n in popup.html.
function t(key, fallback) {
  return window.i18n ? window.i18n.t(key, null, fallback) : fallback;
}

// Which limit sent the customer to the modal. Forwarded to the pricing page
// as `hit` so its copy can match; it is never anything personal.
let proModalReason = "daily";

// Open the upgrade modal with the message that matches why it fired.
function openProModal(reason) {
  proModalReason = PRO_INTROS[reason] ? reason : "daily";
  if (supportIntro) {
    const [key, fallback] = PRO_INTROS[proModalReason];
    supportIntro.textContent = t(key, fallback);
  }
  openModal(supportModal);
}

const limitStatusCard = document.getElementById("limitStatusCard");
const limitStatusLabel = document.getElementById("limitStatusLabel");
const limitStatusLink = document.getElementById("limitStatusLink");

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
/** @type {Array<{uuid:string, file_name:string, content:string, created_at:string, project_uuid:string, estimated_token_count:number|null}>} */
let docs = [];
/** @type {Array<{uuid:string, name:string}>} */
let chatList = [];
/** @type {{uuid:string, name:string, messageCount:number, attachmentCount:number, transcript:object, orgId:string}|null} */
let activeChat = null;
// Project record from the last refresh: title, description, and the Instructions
// panel. Null when Claude didn't return one — the full-project ZIP then simply
// omits instructions.md rather than failing.
/** @type {{name:string, description:string, instructions:string, created_at:string, updated_at:string}|null} */
let projectMeta = null;
// Org + project of the open project, from the docs URL the content script
// used — what the PDF page needs to list the project's chats.
/** @type {{orgId:string, projectId:string}|null} */
let projectRef = null;
let isBusy = false;
// True only while downloadProjectChats is actively awaiting the content script.
// Guards the progress listener so a stale/late CLAUDE_CHATS_PROGRESS message can't
// clobber the docs ZIP progress bar during downloadAllAsZip.
let chatExportActive = false;

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} label
 * @param {"idle"|"ok"|"error"} [type]
 */
function setStatus(label, type = "idle") {
  const i18nMap = {
    "Idle": "statusIdle",
    "Loading…": "statusLoading",
    "Exporting…": "statusExporting",
    "Success": "statusSuccess",
    "Ready": "statusSuccess",
    "Error": "statusError",
    "Preparing…": "statusPreparing"
  };
  const translated = (i18nMap[label] && window.i18n) ? window.i18n.t(i18nMap[label], null, label) : label;
  statusPill.textContent = translated;
  statusPill.className = "status-pill";
  if (type === "ok") statusPill.classList.add("status-pill--ok");
  else if (type === "error") statusPill.classList.add("status-pill--error");
  else statusPill.classList.add("status-pill--idle");
  // Kept for the Report button, so a report says what actually went wrong.
  if (type === "error") noteError("export", label);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status hint helpers (contextual fallback prompts inside the status card)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show a contextual hint with buttons inside the status card.
 * @param {Array<{label:string, prompt:string}>} options
 */
function showStatusHint(options) {
  statusHint.hidden = false;
  statusHint.innerHTML = "";

  const btnsWrap = document.createElement("div");
  btnsWrap.className = "status-hint__btns";

  options.forEach(({ label, prompt }) => {
    const btn = document.createElement("button");
    btn.className = "btn--hint";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      // Set the dynamic prompt in the modal and open it
      fallbackPromptText.textContent = prompt;
      openModal(fallbackModal);
    });
    btnsWrap.appendChild(btn);
  });

  statusHint.appendChild(btnsWrap);
}

function hideStatusHint() {
  statusHint.hidden = true;
  statusHint.innerHTML = "";
}

/**
 * Build a dynamic prompt for a specific file that failed to download.
 */
function buildFileFailedPrompt(fileName) {
  return `The file "${fileName}" failed to download from the project knowledge base. Please locate this exact file in the project knowledge, copy it exactly as-is without modifying or regenerating the content, and provide it as a downloadable file. Maintain the original file format and name.`;
}

/**
 * Build a dynamic prompt for multiple skipped files (ZIP).
 */
function buildSkippedFilesPrompt(fileNames) {
  const list = fileNames.map((n) => `  - ${n}`).join("\n");
  return `The following files from the project knowledge base could not be downloaded directly:\n${list}\n\nPlease locate each of these files, copy them exactly as-is without modifying or regenerating the content, and package them into a single downloadable ZIP file. Maintain original file formats and names.`;
}

/**
 * General prompt for users who want original file formats.
 */
const ORIGINAL_FORMAT_PROMPT = `I need you to create a downloadable ZIP file containing ALL the files in this project's knowledge base. Do NOT regenerate or modify the content — simply copy each file exactly as-is into a ZIP archive and provide a download link. Include every file regardless of format (documents, spreadsheets, images, PDFs, etc.). Maintain the original file formats and names.`;

/**
 * @param {string} label
 * @param {number} current
 * @param {number} total
 */
function showProgress(label, current, total) {
  progressWrap.hidden = false;
  progressLabel.textContent = label;
  progressBar.value = total > 0 ? Math.round((current / total) * 100) : 0;
  progressText.textContent = `${current} / ${total}`;
}

function hideProgress() {
  progressWrap.hidden = true;
  progressBar.value = 0;
  progressText.textContent = "";
}

// ─────────────────────────────────────────────────────────────────────────────
// File-name helpers
// ─────────────────────────────────────────────────────────────────────────────
// getOutputFileName is provided globally by lib/format-loss.js (loaded via
// <script> before this file in popup.html).

/**
 * The user's shared ZIP base name, cleaned of any extension/suffix.
 * All downloads derive their filename from this: `{base}_files.zip`,
 * `{base}_chats.zip`, `{base}.zip`.
 */
function getBaseName() {
  const raw = archiveNameInput.value.trim() || "claude-project";
  return raw.replace(/\.zip$/i, "").replace(/_(files|chats)$/i, "") || "claude-project";
}

// "What's filling this project": files ranked by tokens, with a backup of the
// heavy ones before the user removes them in Claude's own Context panel.
function renderContextCard() {
  const el = document.getElementById("contextMeter");
  const summary = summarizeContext(docs, projectMeta && projectMeta.instructions);
  renderContextMeter(el, summary, {
    onSelectInClaude: projectRef ? (picked) => selectInClaude(projectRef.projectId, picked) : null,
    onBackup: async (picked) => {
      if (isBusy || !picked.length) return;
      if (!(await canBulkDownload())) {
        openProModal("bulk");
        return;
      }
      await buildAndDownloadZip(picked, "txt");
    },
  });
}

// Tick the chosen files in Claude's own Context panel (content/context-select.js).
// Brings the project page up in the active tab first if it isn't there.
async function selectInClaude(projectId, picked) {
  if (!picked.length) return "Tick the files to remove first.";
  const url = `https://claude.ai/project/${projectId}`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tabId = tab && tab.id;
  const onProject = tab && tab.url && tab.url.split(/[?#]/)[0].replace(/\/$/, "") === url;
  if (!tabId || !onProject) {
    const t = tabId ? await chrome.tabs.update(tabId, { url }) : await chrome.tabs.create({ url });
    tabId = t.id;
    await new Promise((resolve) => {
      const done = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }, 15000);
    });
  }
  const res = await sendToTab(tabId, { type: "CPD_SELECT_CONTEXT_FILES", fileNames: picked.map((d) => d.file_name) });
  if (!res || !res.ok) return (res && res.error) || "Couldn't open Claude's Context panel. Open the project and try again.";
  const n = res.ticked;
  const missed = res.missing.length ? ` ${res.missing.length} couldn't be found: ${res.missing.join(", ")}.` : "";
  if (!n) return `Couldn't find those files in Claude's Context panel.${missed}`;
  return `Ticked ${n} file${n > 1 ? "s" : ""} in Claude. Press the highlighted delete button there to remove ${n > 1 ? "them" : "it"}; Claude asks you to confirm.${missed}`;
}

/**
 * Format a token count for display.
 * @param {number|null} count
 */
function fmtTokens(count) {
  if (count == null) return "";
  if (count >= 1000) return `~${(count / 1000).toFixed(1)}k tokens`;
  return `~${count} tokens`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger browser download from a Blob
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {Blob} blob
 * @param {string} fileName
 */
function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: url,
        filename: fileName,
        saveAs: true,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          console.error("Download failed:", chrome.runtime.lastError && chrome.runtime.lastError.message);
          URL.revokeObjectURL(url);
          resolve(null);
          return;
        }
        // Keep the blob alive until Chrome has finished writing it. Revoking on
        // a 5 s timer (pre-1.15) could pull it out from under a slow save
        // dialog, and the "free export used" mark still went down.
        const done = (delta) => {
          if (delta.id !== downloadId || !delta.state) return;
          if (delta.state.current === "complete" || delta.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(done);
            URL.revokeObjectURL(url);
          }
        };
        chrome.downloads.onChanged.addListener(done);
        resolve(downloadId);
      },
    );
  });
}

/**
 * Spend the free tier's one bulk export — but only once the file is saved.
 * background.js watches the download and sets bulkTasteUsed on completion, so
 * a cancelled save dialog or an interrupted download costs nothing, even if
 * this popup has closed by then. No-op for Pro.
 * @param {number|null} downloadId
 */
async function recordBulkWhenSaved(downloadId) {
  if (downloadId == null) return;
  const { isPro } = await checkLicense();
  if (isPro) return;
  const { pendingBulkDownloads = [] } = await chrome.storage.local.get("pendingBulkDownloads");
  await chrome.storage.local.set({ pendingBulkDownloads: [...pendingBulkDownloads, downloadId] });
  // A small file can finish before the line above lands; settle it here.
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item && item.state === "complete") await recordBulkDownload();
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual file download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download a lossy doc's extracted text as a proper .txt file.
 * Spends one download credit (a file was produced).
 * @param {{file_name:string, content:string|null}} doc
 */
async function downloadLossyAsTxt(doc) {
  if (!(await canDownloadSingle())) {
    openProModal("daily");
    return;
  }

  const blob = new Blob([doc.content || ""], { type: "text/plain;charset=utf-8" });
  triggerDownload(blob, toTxtName(doc.file_name));
  await recordDownload();
  await updateLimitUI();
  setStatus(`Downloaded ${toTxtName(doc.file_name)}`, "ok");
}

// The lossy file awaiting the user's single-file choice, retained across the modal.
let pendingLossySingle = null;

/**
 * Open a modal asking how to handle a text-extracted (lossy) file: save the
 * extracted text as .txt now, or ask Claude for the original formatting.
 * @param {{file_name:string, content:string|null}} doc
 */
function openLossySingleModal(doc) {
  pendingLossySingle = doc;
  lossySingleName.textContent = doc.file_name;
  openModal(lossySingleModal);
}

// "Download as .txt": save the extracted text under a proper .txt name.
async function resolveLossySingleAsTxt() {
  const doc = pendingLossySingle;
  closeModal(lossySingleModal);
  if (doc) await downloadLossyAsTxt(doc);
}

// "Ask Claude for the original": hand over the fallback prompt for this file.
function resolveLossySingleAskClaude() {
  const doc = pendingLossySingle;
  closeModal(lossySingleModal);
  if (!doc) return;
  fallbackPromptText.textContent = buildFileFailedPrompt(doc.file_name);
  openModal(fallbackModal);
}

/**
 * @param {{file_name:string, content:string|null, download_url?:string}} doc
 * @param {"native"|"markdown"} format
 */
async function downloadSingleFile(doc, format) {
  // Check daily download limit before continuing
  if (!(await canDownloadSingle())) {
    openProModal("daily");
    return;
  }

  const fileName = getOutputFileName(doc, format);
  hideStatusHint();

  if (doc.download_url) {
    try {
      const absoluteUrl = doc.download_url.startsWith("http")
        ? doc.download_url
        : "https://claude.ai" + doc.download_url;

      const res = await fetch(absoluteUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const blob = await res.blob();
      triggerDownload(blob, fileName);
      await recordDownload();
      await updateLimitUI();
      setStatus(`Downloaded ${doc.file_name}`, "ok");
    } catch (err) {
      console.error("[Claude DL] Binary fetch failed:", err);
      setStatus("Download failed", "error");
      showStatusHint([
        { label: `⚡ "${doc.file_name}" failed — ask Claude for it`, prompt: buildFileFailedPrompt(doc.file_name) },
      ]);
    }
    return;
  }

  // Text doc – create a plain-text blob
  const content = doc.content || "";
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  triggerDownload(blob, fileName);
  await recordDownload();
  await updateLimitUI();
  setStatus(`Downloaded ${doc.file_name}`, "ok");

  // Offer original format prompt for text-extracted files (docx, etc.)
  const ext = doc.file_name?.match(/\.(docx|doc|rtf|odt)$/i);
  if (ext) {
    showStatusHint([
      { label: "📄 Want the original ." + ext[1] + " format? Ask Claude", prompt: buildFileFailedPrompt(doc.file_name) },
    ]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP — download all files
// ─────────────────────────────────────────────────────────────────────────────
async function downloadAllAsZip() {
  if (isBusy || docs.length === 0) return;

  // Bulk lane: free users get one full export ever, then Pro.
  if (!(await canBulkDownload())) {
    openProModal("bulk");
    return;
  }

  // In native mode, text-extracted rich-docs would be zipped as mislabeled
  // text. Ask the user how to handle them before building anything.
  if (formatSelect.value === "native") {
    const { lossy } = partitionLossy(docs);
    if (lossy.length > 0) {
      openLossyBulkModal(lossy);
      return;
    }
  }

  await buildAndDownloadZip(docs, "txt");
}

// Files listed in the pending lossy pre-check, retained across the modal choice.
let pendingLossy = [];

/**
 * Show the pre-check modal listing the text-extracted files, then wait for the
 * user to pick "include as .txt" or "ask Claude for the originals".
 */
function openLossyBulkModal(lossy) {
  pendingLossy = lossy;
  lossyBulkList.innerHTML = "";
  lossy.forEach((doc) => {
    const li = document.createElement("li");
    li.textContent = doc.file_name;
    lossyBulkList.appendChild(li);
  });
  openModal(lossyBulkModal);
}

// "Include them as .txt": zip everything, lossy files renamed to .txt.
async function resolveLossyBulkAsTxt() {
  closeModal(lossyBulkModal);
  await buildAndDownloadZip(docs, "txt");
}

// "Ask Claude for the originals": zip only the safe files (if any), then hand
// the user a prompt listing the lossy ones so they can retrieve the originals.
async function resolveLossyBulkAskClaude() {
  closeModal(lossyBulkModal);
  const names = pendingLossy.map((d) => d.file_name);
  const { safe } = partitionLossy(docs);
  if (safe.length > 0) {
    await buildAndDownloadZip(safe, "skip");
  }
  showStatusHint([
    {
      label: `⚡ ${names.length} file${names.length > 1 ? "s" : ""} need Claude — get the originals`,
      prompt: buildSkippedFilesPrompt(names),
    },
  ]);
}

/**
 * Build and download a ZIP of the given docs.
 * @param {Array} docsToZip files to include
 * @param {"txt"|"skip"} lossyMode "txt" renames text-extracted rich-docs to
 *   .txt; "skip" means the set is already pre-filtered (treat text docs normally).
 */
async function buildAndDownloadZip(docsToZip, lossyMode) {
  if (isBusy) return;
  isBusy = true;
  setBusy(true);

  const format = formatSelect.value;
  const archiveName = `${getBaseName()}_files.zip`;

  try {
    setStatus("Zipping…", "idle");

    const zip = new TinyZip(); // from lib/zip.js

    let skipped = 0;
    const skippedNames = [];

    for (let i = 0; i < docsToZip.length; i++) {
      const doc = docsToZip[i];

      showProgress(`Adding: ${doc.file_name}`, i + 1, docsToZip.length);

      if (doc.download_url) {
        // Fetch the binary blob securely using extension permissions
        try {
          const absoluteUrl = doc.download_url.startsWith("http")
            ? doc.download_url
            : "https://claude.ai" + doc.download_url;

          const res = await fetch(absoluteUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          zip.addFile(getOutputFileName(doc, format), await res.blob());
        } catch (err) {
          console.warn(`[Claude DL] Skipping ${doc.file_name}:`, err);
          skippedNames.push(doc.file_name);
          skipped++;
        }
      } else if (lossyMode === "txt" && isLossyDoc(doc)) {
        // Text-extracted rich-doc: save extracted text under a .txt name.
        zip.addFile(toTxtName(doc.file_name), doc.content || "");
      } else {
        // Standard text doc
        zip.addFile(getOutputFileName(doc, format), doc.content || "");
      }

      // Yield to keep the UI responsive between iterations.
      await new Promise((r) => setTimeout(r, 0));
    }

    showProgress("Generating ZIP…", docsToZip.length, docsToZip.length);
    await new Promise((r) => setTimeout(r, 0));

    const blob = await zip.generateBlob();
    await recordBulkWhenSaved(await triggerDownload(blob, archiveName));
    await updateLimitUI();

    if (skippedNames.length > 0) {
      console.log("[Claude DL] Skipped files:", skippedNames.join(", "));
    }

    setStatus(
      skipped > 0
        ? `Zipped ${docsToZip.length - skipped}/${docsToZip.length}`
        : `Zipped ${docsToZip.length} file${docsToZip.length !== 1 ? "s" : ""}`,
      skipped > 0 ? "idle" : "ok",
    );
    showProgress("Done!", docsToZip.length, docsToZip.length);
    setTimeout(hideProgress, 2500);

    if (skippedNames.length > 0) {
      // Show contextual fallback for skipped files
      const hints = [
        { label: `⚡ ${skippedNames.length} file${skippedNames.length > 1 ? "s" : ""} skipped — ask Claude for them`, prompt: buildSkippedFilesPrompt(skippedNames) },
      ];
      showStatusHint(hints);
    } else {
      hideStatusHint();
    }
  } catch (err) {
    console.error("[Claude DL] ZIP error:", err);
    setStatus("ZIP failed", "error");
    hideProgress();
  } finally {
    isBusy = false;
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat attachments (opt-in for project exports)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolve an attachment URL against claude.ai.
 *
 * Claude returns asset URLs relative ("/api/<org>/files/<id>/document_pdf").
 * The single-chat path fetches them from the content script, where they resolve
 * against claude.ai and work. The popup is an extension page, so the same
 * relative URL resolves against chrome-extension://<id>/ and 404s — which is how
 * the first project export produced "HTTP 404" for every uploaded file while the
 * single-chat export of the same chat saved them fine.
 */
function absoluteClaudeUrl(url) {
  const u = String(url || "");
  if (u.startsWith("http")) return u;
  return "https://claude.ai" + (u.startsWith("/") ? u : "/" + u);
}

/**
 * Add one chat's attachments to the ZIP under `dir`, mirroring the single-chat
 * ZIP path so both exports produce the same files for the same chat.
 * @returns {Promise<string[]>} labels of attachments that could not be saved
 */
async function addChatAttachments(zip, dir, attachments) {
  const failed = [];
  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (!att || !att.name) continue;
    const zipPath = `${dir}/${att.name}`;

    if (att.type === "base64" && att.data) {
      try {
        zip.addFile(zipPath, window.base64ToUint8Array(att.data));
      } catch {
        failed.push(`${att.name} (base64 decode error)`);
      }
    } else if (att.type === "text" && att.content) {
      zip.addFile(zipPath, att.content);
    } else if (att.type === "url") {
      const urls =
        Array.isArray(att.candidateUrls) && att.candidateUrls.length > 0
          ? att.candidateUrls
          : att.url
            ? [att.url]
            : [];
      let saved = false;
      let lastErr = null;
      for (const u of urls) {
        try {
          const res = await fetch(absoluteClaudeUrl(u), { credentials: "include" });
          if (res.ok) {
            zip.addFile(zipPath, await res.blob());
            saved = true;
            break;
          }
          lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
          lastErr = err;
        }
      }
      if (!saved) {
        // Text extracted by Claude is better than nothing when the binary 404s.
        if (att.fallbackText) zip.addFile(`${zipPath}.txt`, att.fallbackText);
        else failed.push(`${att.name} (${lastErr ? lastErr.message : "fetch error"})`);
      }
    }
    await new Promise((r) => setTimeout(r, 0)); // keep the popup responsive
  }
  return failed;
}

/** Folder name for one chat's attachments, derived from its transcript filename. */
function attachmentDirFor(filename) {
  return `${String(filename || "chat").replace(/\.[^.]+$/, "")}_attachments`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP — download all project chats
// ─────────────────────────────────────────────────────────────────────────────
async function downloadProjectChats() {
  if (isBusy) return;

  // Bulk lane: free users get one full export ever, then Pro.
  if (!(await canBulkDownload())) {
    openProModal("bulk");
    return;
  }

  if (chatFormatSelect.value === "pdf") {
    if (!projectRef) {
      setStatus("Open a Claude project and click Refresh first.", "error");
      return;
    }
    openPdf(`project=${projectRef.projectId}&org=${projectRef.orgId}`);
    await recordBulkDownload();
    await updateLimitUI();
    setStatus("PDF of every chat opened in a new tab", "ok");
    return;
  }

  isBusy = true;
  chatExportActive = true;
  setBusy(true);
  hideStatusHint();
  setStatus("Fetching chats…", "idle");
  showProgress("Listing chats…", 0, 0);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = (tab && (tab.url || tab.pendingUrl)) || "";
    if (!tab || !tab.id) throw new Error("No active tab found.");
    if (!tabUrl.includes("claude.ai")) {
      throw new Error("Please open a Claude project first (claude.ai).");
    }

    const format = chatFormatSelect.value === "json" ? "json" : "markdown";
    const includeAttachments = !!(includeAttachmentsCheckbox && includeAttachmentsCheckbox.checked);

    const response = await sendToTab(tab.id, {
      type: "CLAUDE_CHATS_FETCH",
      format,
      includeAttachments,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Failed to fetch chats from Claude.");
    }

    const chats = Array.isArray(response.chats) ? response.chats : [];
    if (chats.length === 0) {
      setStatus("No chats found in this project", "idle");
      hideProgress();
      return;
    }

    showProgress("Generating ZIP…", response.total, response.total);
    const zip = new TinyZip(); // from lib/zip.js
    const attachmentFailures = [];
    for (const chat of chats) {
      zip.addFile(chat.filename, chat.content);
      if (Array.isArray(chat.attachments) && chat.attachments.length > 0) {
        const dir = attachmentDirFor(chat.filename);
        attachmentFailures.push(...(await addChatAttachments(zip, dir, chat.attachments)));
      }
    }
    const failed = Array.isArray(response.failed) ? response.failed : [];
    if (failed.length > 0 || attachmentFailures.length > 0) {
      const sections = [];
      if (failed.length > 0) sections.push(`Failed to export these chats:\n${failed.join("\n")}`);
      if (attachmentFailures.length > 0) {
        sections.push(`Failed to download these attachments:\n${attachmentFailures.join("\n")}`);
      }
      zip.addFile("_export-errors.txt", `${sections.join("\n\n")}\n`);
    }

    const archiveName = `${getBaseName()}_chats.zip`;
    const blob = await zip.generateBlob();
    await recordBulkWhenSaved(await triggerDownload(blob, archiveName));
    await updateLimitUI();

    setStatus(
      failed.length > 0
        ? `Exported ${chats.length}, ${failed.length} failed`
        : `Exported ${chats.length} chat${chats.length !== 1 ? "s" : ""}`,
      failed.length > 0 ? "idle" : "ok"
    );
    showProgress("Done!", response.total, response.total);
    setTimeout(hideProgress, 2500);
  } catch (err) {
    console.error("[Claude DL] Chat export error:", err);
    let displayMessage = err.message || "Chat export failed";
    // Same content-script-not-loaded case the docs flow handles: the tab was open
    // before the extension was installed/updated, so the message never reaches it.
    if (err.message && (err.message.includes("Could not establish connection") || err.message.includes("Receiving end does not exist"))) {
      displayMessage = "Please refresh your Claude project tab and try again. This happens when the extension is installed or updated after the page has already loaded.";
    }
    setStatus(displayMessage, "error");
    hideProgress();
  } finally {
    isBusy = false;
    chatExportActive = false;
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined "found" status label
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {number} fileCount
 * @param {number} chatCount
 * @param {boolean} chatsFailed
 */
function buildFoundStatus(fileCount, chatCount, chatsFailed) {
  const filePart = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
  if (chatsFailed) return `${filePart} found`;
  const chatPart = `${chatCount} chat${chatCount !== 1 ? "s" : ""}`;
  return `${filePart} · ${chatPart} found`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP — download entire project (files + chats in one archive)
// ─────────────────────────────────────────────────────────────────────────────
async function downloadEntireProject() {
  if (isBusy || (docs.length === 0 && chatList.length === 0)) return;

  // Bulk lane: free users get one full export ever, then Pro.
  if (!(await canBulkDownload())) {
    openProModal("bulk");
    return;
  }

  isBusy = true;
  chatExportActive = true; // allow live chat progress messages through
  setBusy(true);
  hideStatusHint();

  const fileFormat = formatSelect.value;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = (tab && (tab.url || tab.pendingUrl)) || "";
    if (!tab || !tab.id) throw new Error("No active tab found.");
    if (!tabUrl.includes("claude.ai")) {
      throw new Error("Please open a Claude project first (claude.ai).");
    }

    const zip = new TinyZip(); // from lib/zip.js
    const skippedNames = [];

    // ── Instructions → instructions.md (root) ───────────────
    // The Instructions panel is a modal in Claude's UI with no export of its
    // own, so this is the only way users get it out. Sits at the archive root
    // because it describes the whole project, not the files or the chats.
    const instructionsMd = buildInstructionsMarkdown(projectMeta); // from lib/project-meta.js
    if (instructionsMd) {
      zip.addFile("instructions.md", instructionsMd);
    }

    // ── Files → files/ ──────────────────────────────────────
    setStatus("Adding files…", "idle");
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const fileName = "files/" + getOutputFileName(doc, fileFormat);
      showProgress(`Adding: ${doc.file_name}`, i + 1, docs.length);

      if (doc.download_url) {
        try {
          const absoluteUrl = doc.download_url.startsWith("http")
            ? doc.download_url
            : "https://claude.ai" + doc.download_url;
          const res = await fetch(absoluteUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          zip.addFile(fileName, await res.blob());
        } catch (err) {
          console.warn(`[Claude DL] Skipping ${doc.file_name}:`, err);
          skippedNames.push(doc.file_name);
        }
      } else {
        zip.addFile(fileName, doc.content || "");
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    // ── Chats → chats/ ──────────────────────────────────────
    let chatCount = 0;
    let chatFailed = [];
    if (chatList.length > 0) {
      setStatus("Fetching chats…", "idle");
      showProgress("Listing chats…", 0, 0);
      const format = chatFormatSelect.value === "json" ? "json" : "markdown";
      const includeAttachments = !!(includeAttachmentsCheckbox && includeAttachmentsCheckbox.checked);
      const response = await sendToTab(tab.id, {
        type: "CLAUDE_CHATS_FETCH",
        format,
        includeAttachments,
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || "Failed to fetch chats from Claude.");
      }
      const chats = Array.isArray(response.chats) ? response.chats : [];
      chatCount = chats.length;
      chatFailed = Array.isArray(response.failed) ? response.failed : [];
      const attachmentFailures = [];
      for (const chat of chats) {
        zip.addFile("chats/" + chat.filename, chat.content);
        if (Array.isArray(chat.attachments) && chat.attachments.length > 0) {
          const dir = "chats/" + attachmentDirFor(chat.filename);
          attachmentFailures.push(...(await addChatAttachments(zip, dir, chat.attachments)));
        }
      }
      if (chatFailed.length > 0 || attachmentFailures.length > 0) {
        const sections = [];
        if (chatFailed.length > 0) {
          sections.push(`Failed to export these chats:\n${chatFailed.join("\n")}`);
        }
        if (attachmentFailures.length > 0) {
          sections.push(`Failed to download these attachments:\n${attachmentFailures.join("\n")}`);
        }
        zip.addFile("chats/_export-errors.txt", `${sections.join("\n\n")}\n`);
      }
    }

    // ── Generate + download ─────────────────────────────────
    showProgress("Generating ZIP…", 1, 1);
    await new Promise((r) => setTimeout(r, 0));

    const archiveName = `${getBaseName()}.zip`;
    const blob = await zip.generateBlob();
    await recordBulkWhenSaved(await triggerDownload(blob, archiveName));
    await updateLimitUI();

    const fileCount = docs.length - skippedNames.length;
    setStatus(`Project ZIP: ${fileCount} file${fileCount !== 1 ? "s" : ""}, ${chatCount} chat${chatCount !== 1 ? "s" : ""}`, "ok");
    showProgress("Done!", 1, 1);
    setTimeout(hideProgress, 2500);

    if (skippedNames.length > 0) {
      showStatusHint([
        { label: `⚡ ${skippedNames.length} file${skippedNames.length > 1 ? "s" : ""} skipped — ask Claude for them`, prompt: buildSkippedFilesPrompt(skippedNames) },
      ]);
    }
  } catch (err) {
    console.error("[Claude DL] Entire project error:", err);
    let displayMessage = err.message || "Project download failed";
    if (err.message && (err.message.includes("Could not establish connection") || err.message.includes("Receiving end does not exist"))) {
      displayMessage = "Please refresh your Claude project tab and try again.";
    }
    setStatus(displayMessage, "error");
    hideProgress();
  } finally {
    isBusy = false;
    chatExportActive = false;
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Enable / disable interactive controls while busy
// ─────────────────────────────────────────────────────────────────────────────
function setBusy(busy) {
  refreshBtn.disabled = busy;
  downloadAllBtn.disabled = busy || docs.length === 0;
  downloadChatsBtn.disabled = busy || chatList.length === 0;
  downloadProjectBtn.disabled = busy || (docs.length === 0 && chatList.length === 0);
  if (downloadSingleChatBtn) downloadSingleChatBtn.disabled = busy || !activeChat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render file list
// ─────────────────────────────────────────────────────────────────────────────
function renderFileList() {
  countPill.textContent = docs.length;
  renderContextCard();

  if (docs.length === 0) {
    fileListContainer.innerHTML = `
      <div class="empty-state">
        <p>No files loaded yet.</p>
        <p class="muted">Open a Claude project, then click ↺ Refresh Files.</p>
      </div>`;
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "file-list";

  docs.forEach((doc) => {
    const li = document.createElement("li");
    li.className = "file-item";

    // ── Left: file info ──────────────────────────────────────
    const info = document.createElement("div");

    const nameP = document.createElement("p");
    nameP.className = "file-item__name";
    nameP.textContent = doc.file_name;

    const sub = document.createElement("span");
    sub.className = "file-item__sub";

    const parts = [];
    if (doc.estimated_token_count !== null && doc.estimated_token_count !== undefined) {
      parts.push(fmtTokens(doc.estimated_token_count));
    } else {
      // Binary files: show a descriptive label based on file kind
      parts.push(doc.file_kind === "image" ? "Image" : "Binary File");
    }
    
    if (doc.created_at) {
      try {
        parts.push(new Date(doc.created_at).toLocaleDateString());
      } catch {
        /* ignore */
      }
    }
    sub.textContent = parts.join(" · ");

    info.appendChild(nameP);
    info.appendChild(sub);

    // ── Right: actions ───────────────────────────────────────
    const actions = document.createElement("div");
    actions.className = "file-item__actions";

    const dlBtn = document.createElement("button");
    dlBtn.className = "btn btn--ghost btn--small";
    dlBtn.textContent = "↓";
    dlBtn.title = "Download this file";
    dlBtn.addEventListener("click", () => {
      // Native mode on a text-extracted rich doc: offer a choice instead of
      // silently saving a mislabeled file. Markdown mode already writes .md text.
      if (formatSelect.value === "native" && isLossyDoc(doc)) {
        openLossySingleModal(doc);
        return;
      }
      downloadSingleFile(doc, formatSelect.value);
    });

    actions.appendChild(dlBtn);

    li.appendChild(info);
    li.appendChild(actions);
    ul.appendChild(li);
  });

  fileListContainer.innerHTML = "";
  fileListContainer.appendChild(ul);
}

// ─────────────────────────────────────────────────────────────────────────────
// Render chat list (mirrors renderFileList)
// ─────────────────────────────────────────────────────────────────────────────
function renderChatList() {
  chatCountPill.textContent = chatList.length;

  if (chatList.length === 0) {
    chatListContainer.innerHTML = `
      <div class="empty-state">
        <p>No chats loaded yet.</p>
        <p class="muted">Open a Claude project, then click ↺ Refresh.</p>
      </div>`;
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "file-list";

  chatList.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "file-item";

    const info = document.createElement("div");

    const nameP = document.createElement("p");
    nameP.className = "file-item__name";
    nameP.textContent = chat.name || "untitled";

    const sub = document.createElement("span");
    sub.className = "file-item__sub";
    sub.textContent = "Chat";

    info.appendChild(nameP);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "file-item__actions";

    const dlBtn = document.createElement("button");
    dlBtn.className = "btn btn--ghost btn--small";
    dlBtn.textContent = "↓";
    dlBtn.title = "Download this chat";
    dlBtn.addEventListener("click", () => downloadSingleChat(chat));

    actions.appendChild(dlBtn);

    li.appendChild(info);
    li.appendChild(actions);
    ul.appendChild(li);
  });

  chatListContainer.innerHTML = "";
  chatListContainer.appendChild(ul);
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual chat download
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Download the currently active single chat from popup.
 */
async function downloadActiveSingleChat() {
  if (isBusy || !activeChat || !activeChat.transcript) return;

  if (!(await canDownloadSingle())) {
    openProModal("daily");
    return;
  }

  isBusy = true;
  setBusy(true);
  hideStatusHint();

  const format = singleChatFormatSelect ? singleChatFormatSelect.value : "zip";
  if (format === "pdf") {
    openPdf(`chat=${activeChat.uuid}${activeChat.orgId ? `&org=${activeChat.orgId}` : ""}`);
    await recordDownload();
    await updateLimitUI();
    setStatus(`PDF opened for "${activeChat.name || "this chat"}"`, "ok");
    return;
  }
  const title = activeChat.name || "untitled";
  const uuid = activeChat.uuid;
  const orgId = activeChat.orgId;
  const transcript = activeChat.transcript;

  setStatus(`Saving "${title}"…`, "idle");
  showProgress("Preparing download…", 0, 1);

  try {
    if (format === "zip") {
      const zip = new TinyZip();
      const safeTitle = window.sanitizeChatFilename(title, uuid, "md").replace(/\.md$/, "");
      const archiveName = `${safeTitle}.zip`;

      // 1. Add Markdown transcript at root
      const mdContent = window.transcriptToMarkdown(transcript);
      zip.addFile(`${safeTitle}.md`, mdContent);

      // 2. Extract and download attachments
      const attachments = window.extractChatAttachments ? window.extractChatAttachments(transcript, orgId) : [];
      const failedAttachments = [];

      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        showProgress(`Adding: ${att.name}`, i + 1, attachments.length);
        const zipPath = `attachments/${att.name}`;

        if (att.type === "base64" && att.data) {
          try {
            const bytes = window.base64ToUint8Array(att.data);
            zip.addFile(zipPath, bytes);
          } catch (e) {
            failedAttachments.push(`${att.name} (base64 decode error)`);
          }
        } else if (att.type === "text" && att.content) {
          zip.addFile(zipPath, att.content);
        } else if (att.type === "url") {
          const candidateUrls = Array.isArray(att.candidateUrls) && att.candidateUrls.length > 0
            ? att.candidateUrls
            : (att.url ? [att.url] : []);

          let downloaded = false;
          let lastErr = null;

          for (const u of candidateUrls) {
            try {
              const res = await fetch(u, { credentials: "include" });
              if (res.ok) {
                const blob = await res.blob();
                zip.addFile(zipPath, blob);
                downloaded = true;
                break;
              } else {
                lastErr = new Error(`HTTP ${res.status}`);
              }
            } catch (err) {
              lastErr = err;
            }
          }

          if (!downloaded) {
            if (att.fallbackText) {
              zip.addFile(`${zipPath}.txt`, att.fallbackText);
            } else {
              failedAttachments.push(`${att.name} (${lastErr ? lastErr.message : "fetch error"})`);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      if (failedAttachments.length > 0) {
        zip.addFile(
          "attachments/_export-errors.txt",
          `The following attachments could not be downloaded via the Claude API:\n` +
            failedAttachments.map((f) => `- ${f}`).join("\n") +
            `\n`
        );
      }

      showProgress("Generating ZIP…", 1, 1);
      const zipBlob = await zip.generateBlob();
      triggerDownload(zipBlob, archiveName);
    } else if (format === "json") {
      const content = window.transcriptToJson(transcript);
      const blob = new Blob([content], { type: "application/json;charset=utf-8" });
      triggerDownload(blob, window.sanitizeChatFilename(title, uuid, "json"));
    } else {
      // Markdown (.md)
      const content = window.transcriptToMarkdown(transcript);
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      triggerDownload(blob, window.sanitizeChatFilename(title, uuid, "md"));
    }

    await recordDownload();
    await updateLimitUI();
    setStatus(`Downloaded "${title}"`, "ok");
    showProgress("Done!", 1, 1);
    setTimeout(hideProgress, 2000);
  } catch (err) {
    console.error("[Claude DL] Active chat download error:", err);
    setStatus("Download failed", "error");
    hideProgress();
  } finally {
    isBusy = false;
    setBusy(false);
  }
}

// "Save as PDF": print/print.html fetches the chats and opens Chrome's print
// dialog. Callers check the free limits first, as for any other format.
function openPdf(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`print/print.html?${query}`) });
}

/**
 * @param {{uuid:string, name:string}} chat
 */
async function downloadSingleChat(chat) {
  if (isBusy) return;

  if (!(await canDownloadSingle())) {
    openProModal("daily");
    return;
  }

  hideStatusHint();
  if (chatFormatSelect.value === "pdf") {
    openPdf(`chat=${chat.uuid}${projectRef ? `&org=${projectRef.orgId}` : ""}`);
    await recordDownload();
    await updateLimitUI();
    setStatus(`PDF opened for "${chat.name}"`, "ok");
    return;
  }
  setStatus(`Fetching "${chat.name}"…`, "idle");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = (tab && (tab.url || tab.pendingUrl)) || "";
    if (!tab || !tab.id) throw new Error("No active tab found.");
    if (!tabUrl.includes("claude.ai")) {
      throw new Error("Please open a Claude chat or project first (claude.ai).");
    }

    const format = chatFormatSelect.value === "json" ? "json" : "markdown";

    const response = await sendToTab(tab.id, {
      type: "CLAUDE_CHAT_FETCH_ONE",
      uuid: chat.uuid,
      name: chat.name,
      format,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Failed to fetch chat from Claude.");
    }

    const blob = new Blob([response.content || ""], { type: "text/plain;charset=utf-8" });
    triggerDownload(blob, response.filename);
    await recordDownload();
    await updateLimitUI();
    setStatus(`Downloaded "${chat.name}"`, "ok");
  } catch (err) {
    console.error("[Claude DL] Single chat error:", err);
    let displayMessage = err.message || "Chat download failed";
    if (err.message && (err.message.includes("Could not establish connection") || err.message.includes("Receiving end does not exist"))) {
      displayMessage = "Please refresh your Claude tab and try again.";
    }
    setStatus(displayMessage, "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch docs via content script
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Guidance when this tab has nothing to export yet
// ─────────────────────────────────────────────────────────────────────────────
const contextGuide = document.getElementById("contextGuide");
const contextGuideText = document.getElementById("contextGuideText");
const contextGuideBtn = document.getElementById("contextGuideBtn");

/** @param {"offsite"|"projects"|"claude"|null} where  null hides the guide */
function showGuide(where) {
  const on = !!where;
  contextGuide.hidden = !on;
  document.querySelector(".context-card__row").hidden = on;
  if (projectControlsGroup) projectControlsGroup.hidden = on || projectControlsGroup.hidden;
  if (filesSection) filesSection.hidden = on;
  if (chatsSection) chatsSection.hidden = on;
  if (!on) return;
  const text = {
    offsite: ["guideOffsite", "Open claude.ai to export a project or chat. Your limits and backups work from any tab."],
    projects: ["guideProjects", "👈 Click any project in the list. This panel fills in with its files and chats, ready to download."],
    claude: ["guideClaude", "Open a project (Projects in Claude's sidebar) or any chat — this panel shows what you can download from it."],
  }[where];
  contextGuideText.textContent = t(text[0], text[1]);
  if (where === "projects") pointAtPage();
  contextGuideBtn.hidden = where === "projects";
  contextGuideBtn.onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = "https://claude.ai/projects";
    if (tab && tab.id && where === "claude") chrome.tabs.update(tab.id, { url });
    else chrome.tabs.create({ url });
  };
}

// The projects hint starts with 👈 in every locale, which is right for a popup
// or a right-docked side panel. Docked on the left, the page is to our right.
async function pointAtPage() {
  if (document.documentElement.classList.contains("is-popup")) return;
  let side = null;
  try {
    // Chrome 140+; older builds have no getLayout, so the hint loses its finger.
    if (chrome.sidePanel && typeof chrome.sidePanel.getLayout === "function") {
      side = (await chrome.sidePanel.getLayout()).side;
    }
  } catch {
    side = null;
  }
  const text = contextGuideText.textContent.replace(/^\s*👈\uFE0F?\s*/u, "");
  contextGuideText.textContent = side === "right" ? `👈 ${text}` : side === "left" ? `👉 ${text}` : text;
}

async function refreshDocs() {
  if (isBusy) return;

  isBusy = true;
  setBusy(true);
  setStatus("Fetching…", "idle");
  hideProgress();
  hideStatusHint();

  // Reset state
  docs = [];
  chatList = [];
  activeChat = null;
  projectMeta = null;
  projectRef = null;
  renderFileList();
  renderChatList();
  projectText.textContent = "—";

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.id) {
      throw new Error("No active tab found.");
    }

    // Validate we're on Claude
    const tabUrl = tab.url || tab.pendingUrl || "";
    if (!tabUrl.includes("claude.ai")) {
      // Not an error in a side panel: it stays open on every tab.
      setStatus("Idle", "idle");
      showGuide("offsite");
      return;
    }

    // Ask the content script to fetch context
    const response = await sendToTab(tab.id, { type: "CLAUDE_DOCS_FETCH" });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Failed to fetch content from Claude.");
    }

    // Handle single chat page mode
    if (response.pageType === "chat" && response.chat) {
      showGuide(null);
      activeChat = response.chat;
      if (contextLabel) contextLabel.textContent = window.i18n ? window.i18n.t("contextChat", null, "Chat") : "Chat";
      projectText.textContent = activeChat.name;
      if (singleChatTitle) singleChatTitle.textContent = activeChat.name;
      if (singleChatMeta) {
        singleChatMeta.textContent = window.i18n
          ? window.i18n.t("singleChatMeta", [String(activeChat.messageCount), String(activeChat.attachmentCount)], `${activeChat.messageCount} messages · ${activeChat.attachmentCount} attachments`)
          : `${activeChat.messageCount} messages · ${activeChat.attachmentCount} attachments`;
      }
      if (singleChatCard) singleChatCard.hidden = false;
      if (projectControlsGroup) projectControlsGroup.hidden = true;
      if (filesSection) filesSection.hidden = true;
      if (chatsSection) chatsSection.hidden = true;

      setStatus("Ready", "ok");
      return;
    }

    // Handle project mode or generic page mode
    activeChat = null;
    if (contextLabel) contextLabel.textContent = window.i18n ? window.i18n.t("contextProject", null, "Project") : "Project";
    if (singleChatCard) singleChatCard.hidden = true;
    if (projectControlsGroup) projectControlsGroup.hidden = false;
    if (filesSection) filesSection.hidden = false;
    if (chatsSection) chatsSection.hidden = false;

    if (response.pageType === "generic") {
      projectText.textContent = "—";
      renderFileList();
      renderChatList();
      setStatus("Idle", "idle");
      showGuide(/claude\.ai\/projects\/?(?:[?#]|$)/.test(tabUrl) ? "projects" : "claude");
      return;
    }
    showGuide(null);

    docs = Array.isArray(response.docs) ? response.docs : [];
    projectMeta = response.project || null;
    const ref = String(response.docsUrl || "").match(/organizations\/([0-9a-f-]{36})\/projects\/([0-9a-f-]{36})/i);
    projectRef = ref ? { orgId: ref[1], projectId: ref[2] } : null;

    // The project's name; its id only if Claude returned no record.
    if (projectMeta && projectMeta.name) {
      projectText.textContent = projectMeta.name;
      projectText.title = projectMeta.name;
    } else if (response.docsUrl) {
      const m = response.docsUrl.match(/projects\/([^/?#]+)/);
      if (m) {
        const id = m[1];
        projectText.textContent = id.length > 22 ? id.slice(0, 22) + "…" : id;
      }
    }

    renderFileList();

    // Also load the chat list (non-fatal — files already rendered).
    let chatsFailed = false;
    try {
      const chatRes = await sendToTab(tab.id, { type: "CLAUDE_CHATS_LIST" });
      if (!chatRes || !chatRes.ok) throw new Error(chatRes?.error || "Failed to list chats.");
      chatList = Array.isArray(chatRes.chats) ? chatRes.chats : [];
      renderChatList();
    } catch (chatErr) {
      console.warn("[Claude DL] Could not list chats:", chatErr);
      chatsFailed = true;
      chatList = [];
      chatCountPill.textContent = "0";
      chatListContainer.innerHTML = `
        <div class="empty-state error-state">
          <p class="error-state__title">Could not load chats.</p>
          <p class="error-state__msg">Files loaded fine — try Refresh again for chats.</p>
        </div>`;
    }

    setStatus(buildFoundStatus(docs.length, chatList.length, chatsFailed),
      docs.length > 0 || chatList.length > 0 ? "ok" : "idle");
  } catch (err) {
    console.error("[Claude DL] Fetch error:", err);
    setStatus("Error", "error");

    let displayMessage = err.message;
    if (err.message && (err.message.includes("Could not establish connection") || err.message.includes("Receiving end does not exist"))) {
      displayMessage = "Please refresh your Claude tab and try again. This happens when the extension is installed or updated after the page has already loaded.";
    }

    // Show the error message in the project text area
    projectText.textContent = displayMessage;

    // Also show a hint in the file list area
    fileListContainer.innerHTML = `
      <div class="empty-state error-state">
        <p class="error-state__title">Could not load content.</p>
        <p class="error-state__msg">${escapeHtml(displayMessage)}</p>
        <button class="btn btn--err btn--small btn--block" id="tsBtn" style="margin-top:10px;">⚠ Troubleshoot</button>
      </div>`;

    // Wire up the dynamically-injected troubleshoot button
    const tsBtn = document.getElementById("tsBtn");
    if (tsBtn)
      tsBtn.addEventListener("click", () => openModal(troubleshootModal));
  } finally {
    isBusy = false;
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: HTML-escape for safe innerHTML insertion
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal helpers
// ─────────────────────────────────────────────────────────────────────────────
function openModal(modal) {
  modal.hidden = false;
}

function closeModal(modal) {
  modal.hidden = true;
}

// Open external links inside extension popups in a real Chrome tab.
function openExternalLink(url) {
  chrome.tabs.create({ url });
}

// The pricing page is a full web page; next to an open side panel it renders
// squeezed. Open it, then get out of the way: close the panel (popup mode
// closes itself when the new tab takes focus).
function openPricingPage(url) {
  chrome.tabs.create({ url });
  if (new URLSearchParams(location.search).get("mode") === "popup") return;
  setTimeout(() => window.close(), 150);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────
refreshBtn.addEventListener("click", refreshDocs);
downloadAllBtn.addEventListener("click", downloadAllAsZip);
downloadChatsBtn.addEventListener("click", downloadProjectChats);
downloadProjectBtn.addEventListener("click", downloadEntireProject);

if (downloadSingleChatBtn) {
  downloadSingleChatBtn.addEventListener("click", downloadActiveSingleChat);
}

// Restore + persist single chat download format (default: zip).
chrome.storage.local.get(["single_chat_download_mode"]).then(({ single_chat_download_mode }) => {
  if (singleChatFormatSelect) {
    singleChatFormatSelect.value = single_chat_download_mode || "zip";
  }
});
if (singleChatFormatSelect) {
  singleChatFormatSelect.addEventListener("change", () => {
    chrome.storage.local.set({ single_chat_download_mode: singleChatFormatSelect.value });
  });
}

// Restore + persist the project chat export format (default: markdown).
chrome.storage.local.get(["chat_export_format"]).then(({ chat_export_format }) => {
  chatFormatSelect.value = ["json", "pdf"].includes(chat_export_format) ? chat_export_format : "markdown";
});
chatFormatSelect.addEventListener("change", () => {
  chrome.storage.local.set({ chat_export_format: chatFormatSelect.value });
});

// Restore + persist "include chat attachments". Defaults to OFF: attachments can
// multiply the archive size, and the whole-project export is the lane where that
// hurts most.
chrome.storage.local.get(["include_chat_attachments"]).then(({ include_chat_attachments }) => {
  if (includeAttachmentsCheckbox) {
    includeAttachmentsCheckbox.checked = include_chat_attachments === true;
  }
});
if (includeAttachmentsCheckbox) {
  includeAttachmentsCheckbox.addEventListener("change", () => {
    chrome.storage.local.set({ include_chat_attachments: includeAttachmentsCheckbox.checked });
  });
}

// Live progress from the content script while chats are being fetched.
chrome.runtime.onMessage.addListener((msg) => {
  if (chatExportActive && msg && msg.type === "CLAUDE_CHATS_PROGRESS") {
    showProgress("Exporting chats…", msg.current, msg.total);
  }
});

// How to Use modal
howToBtn.addEventListener("click", () => openModal(howToModal));
closeHowToBtn.addEventListener("click", () => closeModal(howToModal));
howToBackdrop.addEventListener("click", () => closeModal(howToModal));



// Troubleshoot modal
closeTroubleshootBtn.addEventListener("click", () =>
  closeModal(troubleshootModal),
);
troubleshootBackdrop.addEventListener("click", () =>
  closeModal(troubleshootModal),
);

// Tutorial link — must open in a real tab from an extension popup
if (modalTutorialLink) {
  modalTutorialLink.addEventListener("click", (e) => {
    e.preventDefault();
    openExternalLink(modalTutorialLink.href);
  });
}



// Troubleshoot guide link — open in a real tab
const troubleshootGuideLink = document.getElementById("troubleshootGuideLink");
if (troubleshootGuideLink) {
  troubleshootGuideLink.addEventListener("click", (e) => {
    e.preventDefault();
    openExternalLink(troubleshootGuideLink.href);
  });
}

// Fallback modal
closeFallbackBtn.addEventListener("click", () => closeModal(fallbackModal));
fallbackBackdrop.addEventListener("click", () => closeModal(fallbackModal));
closeLossyBulkBtn.addEventListener("click", () => closeModal(lossyBulkModal));
lossyBulkBackdrop.addEventListener("click", () => closeModal(lossyBulkModal));
lossyBulkTxtBtn.addEventListener("click", resolveLossyBulkAsTxt);
lossyBulkAskBtn.addEventListener("click", resolveLossyBulkAskClaude);
closeLossySingleBtn.addEventListener("click", () => closeModal(lossySingleModal));
lossySingleBackdrop.addEventListener("click", () => closeModal(lossySingleModal));
lossySingleTxtBtn.addEventListener("click", resolveLossySingleAsTxt);
lossySingleAskBtn.addEventListener("click", resolveLossySingleAskClaude);
copyFallbackBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(fallbackPromptText.textContent.trim());
    copyFallbackBtn.textContent = "✓ Copied!";
    copyFallbackBtn.classList.add("btn--copied");
    setTimeout(() => {
      copyFallbackBtn.textContent = "📋 Copy Prompt to Clipboard";
      copyFallbackBtn.classList.remove("btn--copied");
    }, 2000);
  } catch (err) {
    console.error("Clipboard copy failed:", err);
    // Fallback: select the text
    const range = document.createRange();
    range.selectNodeContents(fallbackPromptText);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    copyFallbackBtn.textContent = "Select it manually (Ctrl+C)";
  }
});

// Support modal events
closeSupportBtn.addEventListener("click", () => closeModal(supportModal));
supportBackdrop.addEventListener("click", () => closeModal(supportModal));
supportCheckoutBtn.addEventListener("click", () => {
  openPricingPage(getUpgradeUrl(proModalReason));
});

// ── License key section (bottom of the panel) ───────────────────────────────
// Same activation as the upgrade modal's form; shown whenever Pro isn't active
// (free, or a lapsed subscription that needs a new key).
const keySection = document.getElementById("keySection");
const keySectionInput = document.getElementById("keySectionInput");
const keySectionBtn = document.getElementById("keySectionBtn");
const keySectionMsg = document.getElementById("keySectionMsg");

async function syncKeySection() {
  const { isPro, licenseKey } = await checkLicense();
  if (keySection) keySection.hidden = isPro;
  syncKeyNotice(isPro, licenseKey);
}

// After checkout activated Pro by itself (background.js, CPD_ACTIVATE), show the
// key once so the buyer can keep it; stays until they say they've saved it.
async function syncKeyNotice(isPro, licenseKey) {
  const notice = document.getElementById("keyNotice");
  if (!notice) return;
  const { keyNoticePending } = await chrome.storage.local.get("keyNoticePending");
  notice.hidden = !(isPro && licenseKey && keyNoticePending);
  if (notice.hidden) return;
  const field = document.getElementById("keyNoticeKey");
  const copyBtn = document.getElementById("keyNoticeCopy");
  field.value = licenseKey;
  field.onclick = () => field.select();
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(licenseKey);
      copyBtn.textContent = "Copied";
    } catch {
      field.select();
    }
  };
  document.getElementById("keyNoticeDone").onclick = async () => {
    await chrome.storage.local.set({ keyNoticePending: false });
    notice.hidden = true;
  };
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Pro switched on from outside this panel (checkout's /thanks page): reload so
  // every limit and Pro badge picks it up, as a pasted key does.
  if (changes.isPro && changes.isPro.newValue === true && changes.isPro.oldValue !== true) return window.location.reload();
  if (changes.keyNoticePending || changes.isPro) syncKeySection();
});

async function activateFromKeySection() {
  const key = keySectionInput.value.trim();
  const say = (msg, kind) => {
    keySectionMsg.hidden = !msg;
    keySectionMsg.textContent = msg;
    keySectionMsg.className = `key-section__msg key-section__msg--${kind}`;
  };
  if (!key) return say(t("keySectionEmpty", "Paste your key first."), "err");
  keySectionBtn.disabled = true;
  say(t("keySectionChecking", "Checking your key…"), "ok");
  const result = await activateLicense(key);
  if (result.ok) {
    say(t("keySectionOk", "Pro is on. Reloading…"), "ok");
    setTimeout(() => window.location.reload(), 900);
  } else {
    say(result.error || "Activation failed.", "err");
    keySectionBtn.disabled = false;
  }
}
if (keySectionBtn) {
  keySectionBtn.addEventListener("click", activateFromKeySection);
  keySectionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") activateFromKeySection();
  });
}
syncKeySection();

supportActivateBtn.addEventListener("click", async () => {
  const key = supportLicenseInput.value.trim();
  if (!key) {
    showSupportMessage("Please enter a key", "err");
    return;
  }
  
  supportActivateBtn.disabled = true;
  supportActivateBtn.textContent = "Activating...";
  showSupportMessage("", "clear");
  
  const result = await activateLicense(key);
  if (result.ok) {
    showSupportMessage("Success! Pro Activated.", "ok");
    supportLicenseInput.disabled = true;
    supportActivateBtn.textContent = "Activated";
    // Reload so every card (backups, usage meter, limits) repaints as Pro.
    setTimeout(() => window.location.reload(), 1200);
  } else {
    showSupportMessage(`Error: ${result.error || "Failed"}`, "err");
    supportActivateBtn.disabled = false;
    supportActivateBtn.textContent = "Activate";
  }
});

function showSupportMessage(msg, type) {
  if (type === "clear") {
    supportStatusMsg.hidden = true;
    return;
  }
  supportStatusMsg.hidden = false;
  supportStatusMsg.className = `support__status-msg support__status-msg--${type}`;
  supportStatusMsg.textContent = msg;
  if (type === "ok") {
    supportStatusMsg.style.color = "var(--ok)";
    supportStatusMsg.style.backgroundColor = "#eef9f1";
    supportStatusMsg.style.border = "1px solid #bde1c8";
  } else {
    supportStatusMsg.style.color = "var(--err)";
    supportStatusMsg.style.backgroundColor = "#fff0f0";
    supportStatusMsg.style.border = "1px solid #e8bbbb";
  }
}

async function updateLimitUI() {
  const plan = await planCardContent();
  // Free: the counter sits under the export buttons, where it matters. Pro
  // (or lapsed): one quiet line just above the footer.
  const footer = document.getElementById("appFooter");
  const compact = !!(plan && plan.action === "manage");
  limitStatusCard.classList.toggle("limit-status-card--compact", compact);
  if (compact && footer) footer.before(limitStatusCard);
  else if (projectControlsGroup) projectControlsGroup.after(limitStatusCard);
  if (plan) {
    limitStatusLabel.innerHTML = plan.html;
    limitStatusLink.textContent = plan.link;
    limitStatusLink.onclick = (e) => {
      e.preventDefault();
      // A click on the link is already a decision to look at plans: go
      // straight to the pricing page. The modal is for limits being hit.
      if (plan.action === "renew") openPricingPage(getUpgradeUrl("renew"));
      else openExternalLink(plan.url);
    };
    setUpsell(plan.upsell);
  } else {
    const remaining = await getRemainingDownloads();
    const bulkUsed = await getBulkTasteUsed();
    const sub = bulkUsed
      ? "Full-project export is a Pro feature."
      : "Plus <strong>1 free full export</strong> — download every chat and file at once.";
    limitStatusLabel.innerHTML =
      `<span class="limit-main">You have <strong>${remaining} of ${FREE_DAILY_DOWNLOADS}</strong> free downloads left today.</span>` +
      `<span class="limit-sub">${sub}</span>`;
    limitStatusLink.textContent = t("upgradeLink", "Upgrade to Pro");
    limitStatusLink.onclick = (e) => {
      e.preventDefault();
      openPricingPage(getUpgradeUrl(remaining > 0 ? "welcome" : "daily"));
    };
    setUpsell(null);
  }
}

// "Get Lifetime" on a subscriber's plan card: straight to a checkout that
// upgrades their own key (the Worker supplies the link), else /pro.
function setUpsell(label) {
  const link = document.getElementById("limitStatusUpsell");
  if (!link) return;
  link.hidden = !label;
  link.textContent = label ? `★ ${label}` : "";
  link.onclick = async (e) => {
    e.preventDefault();
    openPricingPage((await getLifetimeUpgradeUrl()) || getUpgradeUrl("lifetime"));
  };
}

// Close modals with Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!howToModal.hidden) closeModal(howToModal);
    if (!troubleshootModal.hidden) closeModal(troubleshootModal);
    if (!fallbackModal.hidden) closeModal(fallbackModal);
    if (!supportModal.hidden) closeModal(supportModal);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
if (typeof window !== "undefined" && window.i18n && typeof window.i18n.translateDOM === "function") {
  window.i18n.translateDOM(document);
}
// First, so the Report button works even if something below throws.
initReport({ page: "export", button: document.getElementById("reportBtn"), getContext: reportContext });
setStatus("Idle", "idle");
renderFileList();
renderChatList();
updateLimitUI();
refreshDocs();
initProFeatures({ openProModal, t, onLicenseChanged: updateLimitUI });

// What the panel was showing when the user hit Report — the "wrong name, no
// chats" reports are only diagnosable with this. The URL keeps its shape but
// drops ids (/project/<id>).
async function reportContext() {
  const text = (el) => (el && !el.closest("[hidden]") ? el.textContent.trim() : undefined);
  let url;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    url = u.hostname === "claude.ai" ? `claude.ai${u.pathname.replace(/[0-9a-f-]{36}/gi, "<id>")}` : "(not claude.ai)";
  } catch { /* no tab access */ }
  return {
    url,
    status: text(statusPill),
    shown: text(projectText),
    files: text(countPill),
    chats: text(chatCountPill),
    singleChat: text(singleChatTitle),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side panel (v1.15): unlike the old popup, this page stays open while the user
// moves between tabs and Claude pages, so follow them. A refresh mid-export
// would wipe the state the export is reading, so wait until it finishes.
// ─────────────────────────────────────────────────────────────────────────────
let followTimer = null;
let followPending = false;
function followActiveTab() {
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    if (isBusy) {
      followPending = true;
      return;
    }
    followPending = false;
    refreshDocs();
  }, 400);
}
chrome.tabs.onActivated.addListener(followActiveTab);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.active) return;
  // claude.ai is a single-page app: a project switch is a URL change, not a load.
  if (info.url || info.status === "complete") followActiveTab();
});
setInterval(() => {
  if (followPending && !isBusy) followActiveTab();
}, 1000);
