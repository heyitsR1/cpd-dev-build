// licensing.js — Vanilla implementation for Claude Project Downloader

// Activation goes through our own Worker rather than straight to Freemius.
//
// Until v1.8.0 this file POSTed to api.freemius.com with the product's public
// key baked into the bundle. Moving it server-side buys three things the popup
// could never do for itself:
//
//   • A licence mirror, so a Freemius suspension cannot tell every paying
//     customer their key is bad on their next reinstall.
//   • A home for the twelve one-time licences sold through Dodo Payments in
//     July 2026. Their 36-char keys mean nothing to Freemius, and Dodo is gone.
//   • A support key, which is only meaningful if a customer cannot read it out
//     of the extension bundle.
//
// It also stops the seat burn: Freemius accepts a `uid` on activation and then
// discards it, so every activation from here minted a fresh install and
// permanently consumed a seat out of the licence's quota. The Worker tags the
// device in a field Freemius actually keeps.
const WORKER_BASE = "https://cpd-license.aarohan567.workers.dev";

// Where "Upgrade to Pro" sends the customer. The extension never states a
// price: the website decides what to show and hands off to Freemius checkout,
// so a price change never needs a store release. `hit` tells the page which
// limit the customer ran into so its copy can match; nothing personal rides
// along.
const UPGRADE_PAGE = "https://claudeprojectdownloader.com/pro";
// Subscription help (status, cancel, lost key, moving browsers) lives on the
// website so it can change without a store release. Only the plan kind and the
// extension version ride along — never the key.
const MANAGE_PAGE = "https://claudeprojectdownloader.com/manage";
// v1.16 adds the Library's limits: folders (a fourth folder), search (matches
// past the top five), and library (the plan line under the Library).
// "lifetime": a monthly or yearly subscriber clicked Get Lifetime on the plan card.
const UPGRADE_HITS = new Set(["daily", "bulk", "welcome", "backup", "usage", "renew", "folders", "search", "library", "lifetime"]);

// Keys bought through the retired 2026 pilot checkout (v1.9–v1.11) still activate:
// the Worker honours them server-side, nothing here needs to know.

// The Worker answers in codes, not sentences. Anything unmapped falls back to
// the generic message rather than showing a customer a raw error code.
const ERROR_MESSAGES = {
  license_not_found:
    "We couldn't verify that license key. Double-check you copied it exactly from your purchase email or the confirmation page.",
  invalid_license_key:
    "We couldn't verify that license key. Double-check you copied it exactly from your purchase email or the confirmation page.",
  license_inactive: "That license has been cancelled. Contact support if you think this is a mistake.",
  license_expired: "That license has expired. Contact support if you think this is a mistake.",
  license_quota_exceeded:
    "That license is already active on the maximum number of devices. Deactivate it elsewhere, or contact support.",
  missing_params: "Something went wrong activating your license. Please try again.",
  network_error: "Couldn't reach the license server. Check your connection and try again.",
};

// Check if running inside Chrome Extension context
const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

async function getStorage(keys) {
  if (hasChromeStorage) {
    return await chrome.storage.local.get(keys);
  } else {
    const res = {};
    const keyList = Array.isArray(keys) ? keys : [keys];
    keyList.forEach(key => {
      try {
        const val = localStorage.getItem(key);
        res[key] = val ? JSON.parse(val) : undefined;
      } catch {
        res[key] = undefined;
      }
    });
    return res;
  }
}

async function setStorage(data) {
  if (hasChromeStorage) {
    await chrome.storage.local.set(data);
  } else {
    Object.entries(data).forEach(([key, val]) => {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch {
        /* ignore */
      }
    });
  }
}

// `tier` is "lifetime", "monthly", or "annual" (the yearly retention offer). `licenseStatus` is "active", or — after a
// revalidation found the licence no longer entitled — "expired" (a subscription
// that stopped renewing) or "cancelled" (a refund). The key is kept in both
// cases so a renewal is picked up by the next revalidation without the
// customer pasting anything again.
export async function checkLicense() {
  const data = await getStorage(["licenseKey", "isPro", "tier", "licenseExpiresAt", "licenseStatus"]);
  return {
    isPro: !!data.isPro,
    licenseKey: data.licenseKey,
    tier: data.tier || (data.isPro ? "lifetime" : null),
    expiresAt: data.licenseExpiresAt || null,
    status: data.licenseStatus || (data.isPro ? "active" : null),
  };
}

// ── Revalidation ─────────────────────────────────────────────────────────────
// Until v1.15 a key was checked once, at activation, and never again: fine for
// a one-time licence, fatal for a subscription (pay once, cancel, keep Pro).
// background.js now calls this on a timer. It only ever acts on a definitive
// answer from the Worker — an outage, a rate limit, or a key the Worker can't
// find all come back `indeterminate` and change nothing.
export const REVALIDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const REVOKING_ERRORS = { license_expired: "expired", license_inactive: "cancelled" };

/**
 * Pure decision: what to store after a /validate-license answer.
 * @returns {object|null} storage patch, or null to leave everything as is
 */
export function applyValidation(result, now = Date.now()) {
  if (!result || typeof result !== "object") return null;
  if (result.valid === true && !result.indeterminate) {
    const patch = { isPro: true, licenseStatus: "active", licenseValidatedAt: now };
    if (result.tier) patch.tier = result.tier;
    if ("expiresAt" in result) patch.licenseExpiresAt = result.expiresAt ?? null;
    return patch;
  }
  if (result.valid === false && REVOKING_ERRORS[result.error]) {
    return { isPro: false, licenseStatus: REVOKING_ERRORS[result.error], licenseValidatedAt: now };
  }
  return null;
}

/** Is it time to ask the Worker again? */
export function revalidationDue(state, now = Date.now()) {
  if (!state || !state.licenseKey) return false;
  // Lapsed: keep checking every tick, so a renewal switches Pro back on fast.
  if (state.licenseStatus === "expired") return true;
  // A subscription past its paid-up date: check now rather than up to a day late.
  if ((state.tier === "monthly" || state.tier === "annual") && state.licenseExpiresAt && now > state.licenseExpiresAt) return true;
  return now - (state.licenseValidatedAt || 0) >= REVALIDATE_EVERY_MS;
}

export async function revalidateLicense({ force = false } = {}) {
  const state = await getStorage(["licenseKey", "tier", "licenseExpiresAt", "licenseValidatedAt", "licenseStatus"]);
  if (!state.licenseKey) return { checked: false };
  if (!force && !revalidationDue(state)) return { checked: false };
  const uid = await getOrCreateUID();
  let result;
  try {
    const response = await fetch(`${WORKER_BASE}/validate-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: state.licenseKey, installId: uid }),
    });
    result = await response.json();
  } catch {
    return { checked: false, error: "network_error" };
  }
  const patch = applyValidation(result);
  if (patch) await setStorage(patch);
  return { checked: true, changed: !!patch, result };
}

async function getOrCreateUID() {
  const data = await getStorage(["install_uid"]);
  if (data.install_uid && data.install_uid.length === 32) {
    return data.install_uid;
  }
  let uid = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const array = new Uint32Array(4);
    crypto.getRandomValues(array);
    for (let i = 0; i < array.length; i++) {
      uid += array[i].toString(16).padStart(8, "0");
    }
  } else {
    const chars = "abcdef0123456789";
    for (let i = 0; i < 32; i++) {
      uid += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  await setStorage({ install_uid: uid });
  return uid;
}

export async function activateLicense(key) {
  const cleanKey = key.trim();
  const uid = await getOrCreateUID();

  let data;
  try {
    const response = await fetch(`${WORKER_BASE}/activate-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: cleanKey, installId: uid }),
    });
    data = await response.json();
  } catch {
    return { ok: false, error: ERROR_MESSAGES.network_error };
  }

  if (!data?.valid) {
    return { ok: false, error: ERROR_MESSAGES[data?.error] || ERROR_MESSAGES.license_not_found };
  }

  await setStorage({
    licenseKey: cleanKey,
    isPro: true,
    // A response without a tier (Freemius's "already activated on this
    // device") keeps whatever this install already knew, defaulting to lifetime.
    ...(data.tier ? { tier: data.tier } : {}),
    licenseExpiresAt: data.expiresAt ?? null,
    licenseValidatedAt: Date.now(),
    licenseStatus: "active",
    // 'freemius' | 'legacy' (a pre-ejection Dodo sale) | 'momo' | 'support'.
    licenseSource: data.source || "freemius",
    // Left over from the Dodo integration. Cleared rather than ignored, so an
    // upgrading install doesn't carry a dead instance id around forever.
    dodoInstanceId: null,
  });
  return { ok: true };
}

export async function deactivateLicense() {
  await setStorage({
    isPro: false,
    licenseKey: null,
    licenseSource: null,
    dodoInstanceId: null,
    tier: null,
    licenseExpiresAt: null,
    licenseValidatedAt: null,
    licenseStatus: null,
  });
  return { ok: true };
}

export async function getFreeDownloadCount() {
  const today = new Date().toDateString();
  const data = await getStorage(["freeDownloadsDate", "freeDownloadsCount"]);
  if (data.freeDownloadsDate !== today) {
    await setStorage({ freeDownloadsDate: today, freeDownloadsCount: 0 });
    return 0;
  }
  return data.freeDownloadsCount || 0;
}

export async function recordDownload() {
  const { isPro } = await checkLicense();
  if (isPro) return;
  const count = await getFreeDownloadCount();
  const today = new Date().toDateString();
  await setStorage({ freeDownloadsDate: today, freeDownloadsCount: count + 1 });
}

// Free users get FREE_DAILY_DOWNLOADS single downloads per calendar day.
export const FREE_DAILY_DOWNLOADS = 5;

export async function getRemainingDownloads() {
  const { isPro } = await checkLicense();
  if (isPro) return Infinity;
  const count = await getFreeDownloadCount();
  return Math.max(0, FREE_DAILY_DOWNLOADS - count);
}

// True if the user may take a single download (one file, one lossy .txt, one
// chat) right now.
//
// v1.11 made singles uncapped; v1.12 restores the daily meter, so this is the
// one gate every single-item download consults. Bulk exports are metered
// separately — see canBulkDownload.
export async function canDownloadSingle() {
  return (await getRemainingDownloads()) > 0;
}

// ── Bulk "taste" lane ────────────────────────────────────────────────────────
// Bulk actions (all files, all chats, entire project) are metered separately
// from the daily single-download counter. A free user gets exactly ONE bulk
// export ever; after that, bulk is Pro-only. This is lifetime, not date-scoped.

export async function getBulkTasteUsed() {
  const data = await getStorage(["bulkTasteUsed"]);
  return !!data.bulkTasteUsed;
}

// True if the user may run a bulk export right now.
export async function canBulkDownload() {
  const { isPro } = await checkLicense();
  if (isPro) return true;
  return !(await getBulkTasteUsed());
}

// Consume the one free bulk export. No-op for Pro users.
export async function recordBulkDownload() {
  const { isPro } = await checkLicense();
  if (isPro) return;
  await setStorage({ bulkTasteUsed: true });
}

// `v` tells the page this build can enforce a subscription (v1.15+). Builds
// that send no `v` are shown the one-time licence only.
export function getUpgradeUrl(hit) {
  const url = new URL(UPGRADE_PAGE);
  url.searchParams.set("src", "ext");
  url.searchParams.set("hit", UPGRADE_HITS.has(hit) ? hit : "daily");
  try {
    url.searchParams.set("v", chrome.runtime.getManifest().version);
  } catch {
    /* not running as an extension (tests) */
  }
  return url.toString();
}

/**
 * "Get Lifetime" for a subscriber: a checkout that upgrades *their* licence
 * (same key, unused days credited) instead of selling a second one. The
 * Worker builds it from the stored key (POST, so the key never rides in a
 * website URL). Null when it can't — the caller falls back to the pricing page.
 */
export async function getLifetimeUpgradeUrl() {
  const { licenseKey } = await getStorage(["licenseKey"]);
  if (!licenseKey) return null;
  try {
    const res = await fetch(`${WORKER_BASE}/upgrade-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey }),
    });
    const data = await res.json();
    return data && data.ok && typeof data.url === "string" && data.url.startsWith("https://") ? data.url : null;
  } catch {
    return null;
  }
}

export function getManageUrl(tier) {
  const url = new URL(MANAGE_PAGE);
  url.searchParams.set("src", "ext");
  if (tier === "monthly" || tier === "annual" || tier === "lifetime") url.searchParams.set("plan", tier);
  try {
    url.searchParams.set("v", chrome.runtime.getManifest().version);
  } catch {
    /* not running as an extension (tests) */
  }
  return url.toString();
}
