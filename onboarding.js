// onboarding.js — Welcome page logic (v1.15)

import { activateLicense, checkLicense, getUpgradeUrl, getManageUrl } from "./popup/licensing.js";

const licenseKeyInput = document.getElementById("licenseKeyInput");
const activateBtn = document.getElementById("activateBtn");
const activationMessage = document.getElementById("activationMessage");
const sellCard = document.getElementById("sellCard");
const activeCard = document.getElementById("activeCard");
const endedCard = document.getElementById("endedCard");
const keyCard = document.getElementById("keyCard");
const activeTier = document.getElementById("activeTier");

function t(key, fallback, subs) {
  const list = subs == null ? undefined : [].concat(subs).map(String);
  if (window.i18n) return window.i18n.t(key, list, fallback);
  return (list || []).reduce((out, v, i) => out.replace(`$${i + 1}`, v), fallback);
}

// Send the buyer to the pricing page; licensing.js is the single source of
// truth for that URL. These are <button>s, not <a>s, deliberately: a pre-set
// href leaks whatever stale URL sits in the markup on middle-click or "copy
// link address".
const checkoutBtn = document.getElementById("checkoutBtn");
if (checkoutBtn) {
  checkoutBtn.addEventListener("click", () => {
    window.open(getUpgradeUrl("welcome"), "_blank", "noopener");
  });
}
const renewBtn = document.getElementById("renewBtn");
if (renewBtn) {
  renewBtn.addEventListener("click", () => {
    window.open(getUpgradeUrl("renew"), "_blank", "noopener");
  });
}

function dateLabel(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return new Date(ms).toDateString();
  }
}

// Free → sell Pro. Pro → show the tier. Lapsed subscription → renew.
async function checkStatus() {
  const lic = await checkLicense();
  const ended = !lic.isPro && lic.licenseKey && (lic.status === "expired" || lic.status === "cancelled");

  sellCard.hidden = lic.isPro || ended;
  activeCard.hidden = !lic.isPro;
  endedCard.hidden = !ended;
  keyCard.hidden = lic.isPro;

  if (lic.isPro) {
    const manage = document.getElementById("manageLink");
    if (manage) manage.href = getManageUrl(lic.tier);
    activeTier.textContent =
      lic.tier === "monthly"
        ? lic.expiresAt
          ? t("obProMonthly", "Monthly · renews $1", dateLabel(lic.expiresAt))
          : t("planMonthly", "Monthly")
        : t("obProLifetime", "Lifetime license — every Pro feature, for good.");
  }
}

// Handle activation click
activateBtn.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    showMessage("Please paste your key first.", "err");
    return;
  }

  activateBtn.disabled = true;
  activateBtn.textContent = "Activating...";
  showMessage("", "clear");

  const result = await activateLicense(key);
  if (result.ok) {
    showMessage("Success! Pro activated. Open the side panel to use it.", "ok");
    licenseKeyInput.disabled = true;
    activateBtn.textContent = "Activated";
    setTimeout(checkStatus, 1500);
  } else {
    showMessage(`Activation failed: ${result.error || "Invalid key"}`, "err");
    activateBtn.disabled = false;
    activateBtn.textContent = t("btnActivate", "Activate");
  }
});

function showMessage(msg, type) {
  if (type === "clear") {
    activationMessage.hidden = true;
    return;
  }

  activationMessage.hidden = false;
  activationMessage.className = `status-msg status-msg--${type}`;
  activationMessage.textContent = msg;
}

// Init
if (typeof window !== "undefined" && window.i18n && typeof window.i18n.translateDOM === "function") {
  window.i18n.translateDOM(document);
}
checkStatus();

// ── One-click start ──────────────────────────────────────────────────────────
// Opens the side panel AND takes this tab to claude.ai/projects, so the first
// thing a new user sees is the panel beside their own project list, telling
// them which project to click. sidePanel.open must run inside the click, so it
// goes first; the navigation follows.
const startBtn = document.getElementById("startBtn");
if (startBtn) {
  let windowId = null;
  chrome.windows.getCurrent().then((w) => (windowId = w.id), () => {});
  startBtn.addEventListener("click", () => {
    if (windowId != null && chrome.sidePanel) chrome.sidePanel.open({ windowId }).catch(() => {});
    window.location.href = "https://claude.ai/projects";
  });
}

// The side panel's "🔑 Key" button lands here: show the key card even for Pro
// (to replace a key), after the licence-state render has run.
if (location.hash === "#key") {
  setTimeout(() => {
    keyCard.hidden = false;
    keyCard.scrollIntoView({ block: "center" });
    const input = document.getElementById("licenseKeyInput");
    if (input && !input.disabled) input.focus();
  }, 300);
}
