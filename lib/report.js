// lib/report.js — "Report a problem", always one click away in the top bar of
// both side-panel screens (v1.17.0).
//
// Before this, the uninstall survey was the only way to tell us something was
// broken, so we heard about bugs from people who had already left. The report
// goes to cpd-license /report (worker/report.js), which emails it to the
// maintainer and lists it on the dashboard.
//
// What rides along: the note, the email only if the user types one, the
// version and plan, what the panel was showing (`getContext`, e.g. the project
// name and chat count), and the last few errors the panel displayed. Never chat
// content or file content.

import { checkLicense } from "../popup/licensing.js";

const REPORT_URL = "https://cpd-license.aarohan567.workers.dev/report";
const SUPPORT_EMAIL = "support@claudeprojectdownloader.com";
const LOG_KEY = "reportLog";
const EMAIL_KEY = "reportEmail";
const MAX_LOG = 15;
const MAX_NOTE = 2000;

// Remember an error the panel showed, so a report sent a minute later can say
// what actually went wrong. Never throws: logging must not break the caller.
export async function noteError(where, message) {
  try {
    if (!message) return;
    const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
    log.push({ ts: new Date().toISOString(), where, message: String(message).slice(0, 300) });
    await chrome.storage.local.set({ [LOG_KEY]: log.slice(-MAX_LOG) });
  } catch { /* ignore */ }
}

const html = `
<form class="report__panel" method="dialog" novalidate>
  <div class="report__head">
    <h3 class="report__title">Report a problem</h3>
    <button type="button" class="report__close" aria-label="Close">×</button>
  </div>
  <div class="report__form">
    <p class="report__lead">Something not working? Tell us. <strong>Most fixes ship within 24 hours</strong> — we read every report.</p>
    <label class="report__label" for="reportNote">What happened?</label>
    <textarea class="report__note" id="reportNote" rows="4" maxlength="${MAX_NOTE}" required
      placeholder="e.g. It found no chats in my project, and showed the wrong name."></textarea>
    <div class="report__email-box">
      <label class="report__label" for="reportEmail">Your email <span class="report__opt">(optional, but it's how we tell you)</span></label>
      <input class="report__email" id="reportEmail" type="email" autocomplete="email" spellcheck="false" placeholder="you@example.com" />
      <p class="report__promise">Leave your email and we'll write back personally the moment it's fixed — usually by the next working day.</p>
    </div>
    <p class="report__fine">We attach the version, your plan, and what this panel was showing — never your chats or files.</p>
    <p class="report__error" role="alert" hidden></p>
    <button type="submit" class="report__send">Send report</button>
  </div>
  <div class="report__done" hidden>
    <p class="report__done-title">Thanks — it's with us.</p>
    <p class="report__done-text"></p>
    <button type="button" class="report__close-done">Close</button>
  </div>
</form>`;

/**
 * Wire the top-bar button to the report dialog.
 * @param {{ page: "export"|"library", button: HTMLElement, getContext?: () => object }} opts
 */
export function initReport({ page, button, getContext }) {
  if (!button) return;
  let dialog = null;

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "report";
    dialog.setAttribute("aria-labelledby", "reportTitle");
    dialog.innerHTML = html;
    dialog.querySelector(".report__title").id = "reportTitle";
    document.body.appendChild(dialog);
    const $ = (sel) => dialog.querySelector(sel);
    const close = () => dialog.close();
    $(".report__close").addEventListener("click", close);
    $(".report__close-done").addEventListener("click", close);
    // A click on the backdrop lands on the <dialog> itself.
    dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
    // Keep keystrokes out of the page's shortcuts (the Library's "/", "n",
    // Escape-clears-selection). The dialog's own Escape-to-close still works.
    dialog.addEventListener("keydown", (e) => e.stopPropagation());
    $(".report__panel").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  }

  async function open() {
    if (!dialog) build();
    const $ = (sel) => dialog.querySelector(sel);
    $(".report__form").hidden = false;
    $(".report__done").hidden = true;
    $(".report__error").hidden = true;
    $(".report__send").disabled = false;
    $(".report__send").textContent = "Send report";
    try {
      const { [EMAIL_KEY]: saved } = await chrome.storage.local.get(EMAIL_KEY);
      if (saved && !$(".report__email").value) $(".report__email").value = saved;
    } catch { /* ignore */ }
    dialog.showModal();
    $(".report__note").focus();
  }

  async function send() {
    const $ = (sel) => dialog.querySelector(sel);
    const note = $(".report__note").value.trim();
    const email = $(".report__email").value.trim();
    const err = $(".report__error");
    err.hidden = true;
    if (!note) {
      err.textContent = "Tell us briefly what went wrong.";
      err.hidden = false;
      $(".report__note").focus();
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      err.textContent = "That email doesn't look right — fix it, or leave it empty.";
      err.hidden = false;
      $(".report__email").focus();
      return;
    }
    $(".report__send").disabled = true;
    $(".report__send").textContent = "Sending…";

    const payload = await buildPayload(note, email);
    let ok = false;
    try {
      const res = await fetch(REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      ok = !!(await res.json().catch(() => null))?.ok;
    } catch { /* fall back to email below */ }

    if (!ok) {
      // Some networks block workers.dev. Hand the user a ready-made email
      // instead of losing the report.
      const body = `${note}\n\n— version ${payload.version}, plan ${payload.tier}, ${JSON.stringify(payload.context)}`;
      err.innerHTML = "";
      err.append("Couldn't send it from here. ");
      const a = document.createElement("a");
      a.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Problem report")}&body=${encodeURIComponent(body)}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `Email it to ${SUPPORT_EMAIL} instead`;
      err.append(a);
      err.hidden = false;
      $(".report__send").disabled = false;
      $(".report__send").textContent = "Try again";
      return;
    }

    try {
      if (email) await chrome.storage.local.set({ [EMAIL_KEY]: email });
      await chrome.storage.local.remove(LOG_KEY);
    } catch { /* ignore */ }
    $(".report__note").value = "";
    $(".report__done-text").textContent = email
      ? `We'll email ${email} as soon as the fix is live — usually by the next working day. Thanks for giving us another shot.`
      : "We'll get on it. Next time, add your email and we'll tell you the moment it's fixed.";
    $(".report__form").hidden = true;
    $(".report__done").hidden = false;
  }

  async function buildPayload(note, email) {
    let tier = "free";
    let installId;
    let log = [];
    let context = {};
    try {
      const lic = await checkLicense();
      if (lic.isPro) tier = lic.status && lic.status !== "active" ? `${lic.tier}-${lic.status}` : lic.tier;
    } catch { /* ignore */ }
    try {
      const got = await chrome.storage.local.get(["install_uid", LOG_KEY]);
      installId = got.install_uid;
      log = got[LOG_KEY] || [];
    } catch { /* ignore */ }
    try {
      context = (getContext && (await getContext())) || {};
    } catch { /* ignore */ }
    return {
      note: note.slice(0, MAX_NOTE),
      email: email || undefined,
      version: chrome.runtime.getManifest().version,
      tier,
      page,
      installId,
      context,
      log,
    };
  }

  button.addEventListener("click", open);
}
