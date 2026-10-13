(() => {
  "use strict";

  // "Select in Claude" from the side panel's "What's filling this project"
  // card (v1.18). Opens the project's Context dialog, switches it to Select,
  // expands any folders that hold the files, and ticks them. It never presses
  // delete: the user does that with Claude's own trash button, which then asks
  // for confirmation. We only point at the button.
  //
  // Claude's markup (Oct 2026): the dialog holds a region labelled
  // "Context files"; each file row has role=checkbox labelled
  // "Select <file name>"; folders expand inline from a button labelled
  // "Open folder <name>"; the trash button is labelled "Delete N selected item(s)".
  // The API's file_name may carry a folder path ("claude/notes.md"); the row
  // label uses only the last part.

  if (window.__CPD_CONTEXT_SELECT__) return;
  window.__CPD_CONTEXT_SELECT__ = true;

  const MESSAGE_TYPE = "CPD_SELECT_CONTEXT_FILES";
  const HIGHLIGHT_ID = "cpd-context-select-style";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  function contextDialog() {
    const region = document.querySelector('[role="dialog"] [aria-label="Context files"]');
    return region ? region.closest('[role="dialog"]') : null;
  }

  // The project page's Context row is covered by a button labelled
  // "Show context"; fall back to the row's text if that label changes.
  function contextOpener() {
    const btn = document.querySelector('button[aria-label="Show context"]');
    if (btn) return btn;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() !== "Context") continue;
      const el = node.parentElement;
      if (!el || el.closest('[role="dialog"]')) continue;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return (hit && hit.closest("button")) || el;
    }
    return null;
  }

  async function openDialog() {
    let dialog = contextDialog();
    if (dialog) return dialog;
    const opener = await waitFor(contextOpener, 8000);
    if (!opener) return null;
    opener.click();
    return waitFor(contextDialog, 5000);
  }

  const buttons = (root) => [...root.querySelectorAll("button")];

  async function enterSelectMode(dialog) {
    const select = buttons(dialog).find((b) => b.textContent.trim() === "Select");
    if (select && select.getAttribute("aria-pressed") !== "true") {
      select.click();
      await waitFor(() => dialog.querySelector('[role="checkbox"]'), 3000);
    }
  }

  async function expandFolders(dialog, folders) {
    for (const name of folders) {
      const btn = dialog.querySelector(`button[aria-label="Open folder ${CSS.escape(name)}"]`);
      if (btn && btn.getAttribute("aria-expanded") !== "true") {
        btn.click();
        await sleep(400);
      }
    }
  }

  function trashButton(dialog) {
    return buttons(dialog).find((b) => /^Delete \d+ selected/.test(b.getAttribute("aria-label") || ""));
  }

  function highlight(el) {
    if (!document.getElementById(HIGHLIGHT_ID)) {
      const style = document.createElement("style");
      style.id = HIGHLIGHT_ID;
      style.textContent = `
        @keyframes cpd-ctx-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,119,6,.0); } 50% { box-shadow: 0 0 0 6px rgba(217,119,6,.55); } }
        [data-cpd-ctx-target] { animation: cpd-ctx-pulse 1.2s ease-in-out 4; border-radius: 8px; }`;
      document.head.appendChild(style);
    }
    el.setAttribute("data-cpd-ctx-target", "");
    setTimeout(() => el.removeAttribute("data-cpd-ctx-target"), 5200);
  }

  async function selectFiles(fileNames) {
    const plan = window.ContextSelect.planSelection(fileNames);
    const dialog = await openDialog();
    if (!dialog) return { ok: false, error: "Couldn't open Claude's Context panel on this page." };
    await enterSelectMode(dialog);
    await expandFolders(dialog, plan.folders);

    const ticked = [];
    const missing = [];
    for (const label of plan.labels) {
      const box = dialog.querySelector(`[role="checkbox"][aria-label="Select ${CSS.escape(label)}"]`);
      if (!box) {
        missing.push(label);
        continue;
      }
      if (box.getAttribute("aria-checked") !== "true") {
        box.click();
        await sleep(60);
      }
      ticked.push(label);
    }
    const trash = await waitFor(() => trashButton(dialog), 1500);
    if (trash) highlight(trash);
    return { ok: true, ticked: ticked.length, missing };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPE || !Array.isArray(message.fileNames)) return;
    selectFiles(message.fileNames).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
    );
    return true;
  });
})();
