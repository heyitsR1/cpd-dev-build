(() => {
  "use strict";

  // Idempotency guard — the popup re-injects content scripts on demand, and a
  // second copy of this file would race the first over the same button.
  if (window.__CLAUDE_DL_CHAT_BUTTON_LOADED__) return;
  window.__CLAUDE_DL_CHAT_BUTTON_LOADED__ = true;

  /**
   * In-page "Download" button for a single chat.
   *
   * Mounts a button next to Claude's Share button that saves whatever
   * transcript is on screen (standalone or inside a project).
   *
   * First click prompts the user for their preferred format:
   * - ZIP with attachments (.zip)
   * - Markdown (.md)
   * - JSON (.json)
   * The choice persists in chrome.storage.local for future one-click downloads.
   * Shift-clicking the button re-opens the format picker anytime.
   */

  function t(key, fallback) {
    if (typeof window !== "undefined" && window.i18n && typeof window.i18n.t === "function") {
      return window.i18n.t(key, null, fallback);
    }
    if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
      const msg = chrome.i18n.getMessage(key);
      if (msg) return msg;
    }
    return fallback;
  }

  const BUTTON_ID = "cpd-download-chat";
  const MODAL_ID = "cpd-format-modal";
  const STYLES_ID = "cpd-chat-styles";
  const SHARE_SELECTOR = '[data-testid="wiggle-controls-actions-share"]';
  const LABEL_IDLE = t("inpageDownloadBtn", "Download");
  const STATUS_RESET_MS = 1800;

  const api = window.ClaudeApi;

  function currentChatId() {
    return api.parseChatIdFromPath(window.location.pathname);
  }

  function labelSpan(button) {
    const spans = button.querySelectorAll("span");
    return spans.length ? spans[spans.length - 1] : null;
  }

  function setLabel(button, text) {
    const span = labelSpan(button);
    if (span) span.textContent = text;
  }

  async function getSavedFormat() {
    try {
      const data = await chrome.storage.local.get(["single_chat_download_mode"]);
      return data.single_chat_download_mode || null;
    } catch {
      return null;
    }
  }

  async function savePreferredFormat(format) {
    try {
      await chrome.storage.local.set({ single_chat_download_mode: format });
    } catch (e) {
      console.warn("[Claude DL] Could not save format preference:", e);
    }
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function saveTextFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    saveBlob(blob, filename);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Modal Styles Injection
  // ─────────────────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLES_ID)) return;
    const style = document.createElement("style");
    style.id = STYLES_ID;
    style.textContent = `
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #1a1a1a;
      }
      @media (prefers-color-scheme: dark) {
        #${MODAL_ID} {
          color: #ededed;
        }
      }
      .cpd-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      .cpd-panel {
        position: relative;
        width: 90%;
        max-width: 440px;
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(0, 0, 0, 0.08);
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        animation: cpdPopIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @media (prefers-color-scheme: dark) {
        .cpd-panel {
          background: #1f1e1d;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        }
      }
      @keyframes cpdPopIn {
        from { transform: scale(0.94); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      .cpd-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .cpd-title {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }
      .cpd-close-btn {
        background: transparent;
        border: none;
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
        color: #888;
        padding: 4px 8px;
        border-radius: 6px;
      }
      .cpd-close-btn:hover {
        background: rgba(0, 0, 0, 0.06);
        color: #111;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-close-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
        }
      }
      .cpd-subtitle {
        font-size: 13px;
        color: #666;
        margin: -8px 0 0 0;
        line-height: 1.4;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-subtitle {
          color: #999;
        }
      }
      .cpd-options {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .cpd-option-card {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 14px;
        border: 2px solid #e5e5e5;
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
        background: #fafafa;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-option-card {
          border-color: #333;
          background: #262524;
        }
      }
      .cpd-option-card:hover {
        border-color: #c37437;
        background: #fdf8f4;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-option-card:hover {
          border-color: #d98a4a;
          background: #2d2a28;
        }
      }
      .cpd-option-card.cpd-selected {
        border-color: #c37437;
        background: #fff8f2;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-option-card.cpd-selected {
          border-color: #d98a4a;
          background: #362f2a;
        }
      }
      .cpd-radio {
        margin-top: 3px;
        accent-color: #c37437;
        cursor: pointer;
      }
      .cpd-option-content {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
      }
      .cpd-option-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cpd-option-title {
        font-size: 14px;
        font-weight: 600;
      }
      .cpd-badge {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        padding: 2px 6px;
        border-radius: 4px;
        background: #eef9f1;
        color: #2b7a42;
        border: 1px solid #bde1c8;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-badge {
          background: #193822;
          color: #6ee7b7;
          border-color: #265935;
        }
      }
      .cpd-option-desc {
        font-size: 12px;
        color: #666;
        line-height: 1.35;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-option-desc {
          color: #999;
        }
      }
      .cpd-persist-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        color: #555;
        cursor: pointer;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-persist-row {
          color: #aaa;
        }
      }
      .cpd-persist-checkbox {
        accent-color: #c37437;
        cursor: pointer;
      }
      .cpd-actions {
        display: flex;
        gap: 10px;
        margin-top: 4px;
      }
      .cpd-btn {
        flex: 1;
        padding: 10px 16px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.15s ease;
      }
      .cpd-btn-primary {
        background: #c37437;
        color: #ffffff;
      }
      .cpd-btn-primary:hover {
        background: #ab612c;
      }
      .cpd-btn-secondary {
        background: transparent;
        color: #666;
        border: 1px solid #ccc;
      }
      @media (prefers-color-scheme: dark) {
        .cpd-btn-secondary {
          color: #aaa;
          border-color: #444;
        }
      }
      .cpd-btn-secondary:hover {
        background: rgba(0, 0, 0, 0.05);
      }
      @media (prefers-color-scheme: dark) {
        .cpd-btn-secondary:hover {
          background: rgba(255, 255, 255, 0.08);
        }
      }
      .cpd-hint {
        font-size: 11px;
        color: #888;
        text-align: center;
        margin: 0;
      }
    `;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Format Choice Modal UI
  // ─────────────────────────────────────────────────────────────────────────────
  function promptFormatChoice(initialFormat = "zip") {
    ensureStyles();

    return new Promise((resolve) => {
      // Remove any prior modal instance
      const existing = document.getElementById(MODAL_ID);
      if (existing) existing.remove();

      let selected = initialFormat || "zip";

      const modal = document.createElement("div");
      modal.id = MODAL_ID;

      modal.innerHTML = `
        <div class="cpd-backdrop"></div>
        <div class="cpd-panel" role="dialog" aria-modal="true" aria-labelledby="cpd-modal-title">
          <div class="cpd-header">
            <h3 class="cpd-title" id="cpd-modal-title">${t("modalDownloadTitle", "Download Chat")}</h3>
            <button class="cpd-close-btn" id="cpd-modal-close" aria-label="Close">×</button>
          </div>
          <p class="cpd-subtitle">${t("modalChooseFormat", "Choose your preferred export format for single chats:")}</p>

          <div class="cpd-options">
            <label class="cpd-option-card ${selected === "zip" ? "cpd-selected" : ""}" data-val="zip">
              <input type="radio" name="cpd-fmt" value="zip" class="cpd-radio" ${selected === "zip" ? "checked" : ""}>
              <div class="cpd-option-content">
                <div class="cpd-option-title-row">
                  <span class="cpd-option-title">${t("formatZipAttachments", "📦 ZIP with Attachments (.zip)")}</span>
                  <span class="cpd-badge">${t("badgeRecommended", "Recommended")}</span>
                </div>
                <span class="cpd-option-desc">${t("modalZipDesc", "Full markdown chat + all uploaded attachments (images, PDFs, documents) in an archive.")}</span>
              </div>
            </label>

            <label class="cpd-option-card ${selected === "markdown" ? "cpd-selected" : ""}" data-val="markdown">
              <input type="radio" name="cpd-fmt" value="markdown" class="cpd-radio" ${selected === "markdown" ? "checked" : ""}>
              <div class="cpd-option-content">
                <div class="cpd-option-title-row">
                  <span class="cpd-option-title">${t("formatMarkdown", "📄 Markdown (.md)")}</span>
                </div>
                <span class="cpd-option-desc">${t("modalMdDesc", "Clean formatted text transcript, ready for Obsidian, Notion, or personal notes.")}</span>
              </div>
            </label>

            <label class="cpd-option-card ${selected === "pdf" ? "cpd-selected" : ""}" data-val="pdf">
              <input type="radio" name="cpd-fmt" value="pdf" class="cpd-radio" ${selected === "pdf" ? "checked" : ""}>
              <div class="cpd-option-content">
                <div class="cpd-option-title-row">
                  <span class="cpd-option-title">📑 PDF (.pdf)</span>
                  <span class="cpd-badge">New</span>
                </div>
                <span class="cpd-option-desc">A clean, printable document with formatting, code and tables. Opens Chrome's Save as PDF.</span>
              </div>
            </label>

            <label class="cpd-option-card ${selected === "json" ? "cpd-selected" : ""}" data-val="json">
              <input type="radio" name="cpd-fmt" value="json" class="cpd-radio" ${selected === "json" ? "checked" : ""}>
              <div class="cpd-option-content">
                <div class="cpd-option-title-row">
                  <span class="cpd-option-title">${t("formatJson", "📋 JSON (.json)")}</span>
                </div>
                <span class="cpd-option-desc">${t("modalJsonDesc", "Raw, lossless conversation data containing the complete API structure.")}</span>
              </div>
            </label>
          </div>

          <label class="cpd-persist-row">
            <input type="checkbox" id="cpd-remember-choice" class="cpd-persist-checkbox" checked>
            <span>${t("modalRememberChoice", "Remember my choice for future one-click downloads")}</span>
          </label>

          <div class="cpd-actions">
            <button class="cpd-btn cpd-btn-secondary" id="cpd-modal-cancel">${t("modalCancelBtn", "Cancel")}</button>
            <button class="cpd-btn cpd-btn-primary" id="cpd-modal-confirm">${t("modalConfirmBtn", "⬇ Download")}</button>
          </div>

          <p class="cpd-hint">${t("modalShiftTip", "💡 Tip: Hold Shift when clicking Download anytime to change this format.")}</p>
        </div>
      `;

      function cleanup() {
        document.removeEventListener("keydown", onKeyDown);
        modal.remove();
      }

      function onKeyDown(e) {
        if (e.key === "Escape") {
          cleanup();
          resolve(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          onConfirm();
        }
      }

      function updateSelection(val) {
        selected = val;
        modal.querySelectorAll(".cpd-option-card").forEach((card) => {
          const isCurrent = card.dataset.val === val;
          card.classList.toggle("cpd-selected", isCurrent);
          const radio = card.querySelector("input[type=radio]");
          if (radio) radio.checked = isCurrent;
        });
      }

      modal.querySelectorAll(".cpd-option-card").forEach((card) => {
        card.addEventListener("click", () => updateSelection(card.dataset.val));
      });

      modal.querySelector(".cpd-backdrop").addEventListener("click", () => {
        cleanup();
        resolve(null);
      });

      modal.querySelector("#cpd-modal-close").addEventListener("click", () => {
        cleanup();
        resolve(null);
      });

      modal.querySelector("#cpd-modal-cancel").addEventListener("click", () => {
        cleanup();
        resolve(null);
      });

      async function onConfirm() {
        const remember = modal.querySelector("#cpd-remember-choice").checked;
        cleanup();
        if (remember) {
          await savePreferredFormat(selected);
        }
        resolve(selected);
      }

      modal.querySelector("#cpd-modal-confirm").addEventListener("click", onConfirm);

      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(modal);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ZIP Download with Attachments
  // ─────────────────────────────────────────────────────────────────────────────
  async function downloadChatAsZip(transcript, title, chatId, orgId, setButtonStatus) {
    if (setButtonStatus) setButtonStatus("Zipping…");

    const zip = new (window.TinyZip || globalThis.TinyZip)();
    const safeTitle = window.sanitizeChatFilename(title, chatId, "md").replace(/\.md$/, "");
    const archiveName = `${safeTitle}.zip`;

    // 1. Add formatted transcript at root
    const mdContent = window.transcriptToMarkdown(transcript);
    zip.addFile(`${safeTitle}.md`, mdContent);

    // 2. Extract and download attachments
    const attachments = window.extractChatAttachments ? window.extractChatAttachments(transcript, orgId) : [];
    const failedAttachments = [];

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const zipPath = `attachments/${att.name}`;

      if (att.type === "base64" && att.data) {
        try {
          const bytes = window.base64ToUint8Array(att.data);
          zip.addFile(zipPath, bytes);
        } catch (e) {
          console.warn(`[Claude DL] Base64 attachment decode failed (${att.name}):`, e);
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
            const res = await api.authenticatedGet(u);
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
            console.warn(`[Claude DL] Failed to download attachment (${att.name}):`, lastErr);
            failedAttachments.push(`${att.name} (${lastErr ? lastErr.message : "fetch error"})`);
          }
        }
      }
    }

    if (failedAttachments.length > 0) {
      zip.addFile(
        "attachments/_export-errors.txt",
        `The following attachments could not be downloaded via the Claude API:\n` +
          failedAttachments.map((f) => `- ${f}`).join("\n") +
          `\n`
      );
    }

    const zipBlob = await zip.generateBlob();
    saveBlob(zipBlob, archiveName);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Download Dispatcher
  // ─────────────────────────────────────────────────────────────────────────────
  async function downloadCurrentChat(button, forceFormatPrompt = false) {
    const chatId = currentChatId();
    if (!chatId) throw new Error("No chat is open on this page.");

    const orgId = (await api.fetchActiveOrgId?.()) || api.parseOrgIdFromCookie(document.cookie);
    if (!orgId) {
      throw new Error("Could not identify your Claude organization. Reload the page and retry.");
    }

    let format = await getSavedFormat();

    if (forceFormatPrompt || !format) {
      format = await promptFormatChoice(format || "zip");
      if (!format) return; // User cancelled
    }

    if (format === "pdf") {
      // print/print.html fetches and lays out the chat itself.
      chrome.runtime.sendMessage({ type: "OPEN_PDF", query: `chat=${chatId}&org=${orgId}` });
      return "PDF opened";
    }

    setLabel(button, "Saving…");

    const transcript = await api.fetchTranscript(orgId, chatId);
    const title = transcript.name || document.title.replace(/\s*[-–|]\s*Claude\s*$/i, "") || "untitled";
    if (!transcript.name) transcript.name = title;

    if (format === "zip") {
      await downloadChatAsZip(transcript, title, chatId, orgId, (status) => setLabel(button, status));
    } else if (format === "json") {
      const content = window.transcriptToJson(transcript);
      saveTextFile(content, window.sanitizeChatFilename(title, chatId, "json"));
    } else {
      // Default: Markdown (.md)
      const content = window.transcriptToMarkdown(transcript);
      saveTextFile(content, window.sanitizeChatFilename(title, chatId, "md"));
    }
  }

  let resetTimer = null;

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    if (button.dataset.busy === "1") return;

    button.dataset.busy = "1";
    button.setAttribute("aria-busy", "true");
    clearTimeout(resetTimer);

    const isShiftClick = event.shiftKey;

    try {
      const label = await downloadCurrentChat(button, isShiftClick);
      setLabel(button, label || "Saved");
    } catch (error) {
      console.error("[Claude DL] Chat download failed:", error);
      setLabel(button, "Failed");
    } finally {
      button.dataset.busy = "0";
      button.removeAttribute("aria-busy");
      resetTimer = setTimeout(() => setLabel(button, LABEL_IDLE), STATUS_RESET_MS);
    }
  }

  // Clone Claude's Share button so ours inherits the current design system
  function buildButton(shareButton) {
    const button = shareButton.cloneNode(true);
    button.id = BUTTON_ID;
    button.dataset.testid = BUTTON_ID;
    button.removeAttribute("aria-pressed");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-haspopup");
    button.dataset.busy = "0";
    // The clone sits flush against Share and the files counter; give it room.
    button.style.marginInline = "6px";
    button.title =t("inpageDownloadTooltip", "Download chat transcript (Shift+Click to change format)");
    setLabel(button, LABEL_IDLE);
    button.addEventListener("click", onClick);
    return button;
  }

  function ensureButton() {
    const existing = document.getElementById(BUTTON_ID);

    if (!currentChatId()) {
      // Navigated away from a chat (project overview, new chat, settings).
      if (existing) existing.remove();
      return;
    }

    const shareButton = document.querySelector(SHARE_SELECTOR);
    if (!shareButton) return; // Controls not rendered yet — the observer retries.

    // Mount relative to Share's own parent.
    //
    // This previously resolved a wrapper via closest(GROUP_SELECTOR) and called
    // group.insertBefore(button, shareButton). Claude now nests Share several
    // levels beneath that wrapper, so the reference node was not a direct child
    // of `group` and insertBefore threw NotFoundError (a DOMException) on every
    // observer tick. The catch in schedule() swallowed it into a console.warn
    // that only shows in the isolated world, so the button simply never appeared
    // and there was no visible reason why. insertAdjacentElement cannot have
    // that mismatch: it positions relative to the element itself.
    const container = shareButton.parentElement;
    if (!container) return;

    if (existing && existing.parentElement === container) return;
    if (existing) existing.remove();

    shareButton.insertAdjacentElement("beforebegin", buildButton(shareButton));
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        ensureButton();
      } catch (error) {
        console.warn("[Claude DL] Could not place the chat download button:", error);
      }
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  schedule();
})();
