// lib/usage.js — Claude's own usage limits, read from the account's /usage
// endpoint: GET /api/organizations/{org}/usage
//
//   { five_hour: { utilization: 0..100, resets_at: ISO },
//     seven_day: { utilization: 0..100, resets_at: ISO },
//     seven_day_opus / seven_day_sonnet / …: same shape or null, … }
//
// Shape verified against claude.ai on 2026-10-04. The response carries dozens of
// other (mostly null, internally code-named) buckets; only the two windows every
// plan has are surfaced, plus the per-model weekly ones when present.
//
// Loaded as a content-script/popup global (window.ClaudeUsage) and as a
// CommonJS module for the Node tests.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ClaudeUsage = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MODEL_BUCKETS = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

  function pct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function window_(raw) {
    if (!raw || typeof raw !== "object") return null;
    const p = pct(raw.utilization);
    if (p == null) return null;
    const t = Date.parse(raw.resets_at || "");
    return { pct: p, resetsAt: Number.isNaN(t) ? null : t };
  }

  /**
   * @returns {{session: {pct:number, resetsAt:number|null}|null,
   *            weekly: {pct:number, resetsAt:number|null}|null,
   *            models: {label:string, pct:number, resetsAt:number|null}[]}|null}
   */
  function parseUsage(raw) {
    if (!raw || typeof raw !== "object") return null;
    const session = window_(raw.five_hour);
    const weekly = window_(raw.seven_day);
    const models = [];
    const seen = new Set();
    // Current shape: `limits: [{ kind: "weekly_scoped", percent, resets_at,
    // scope: { model: { display_name: "Fable" } | null, surface } }]` — a model
    // (or surface) with its own weekly cap. Verified live 2026-10-04 (Fable).
    for (const l of Array.isArray(raw.limits) ? raw.limits : []) {
      if (!l || l.kind !== "weekly_scoped") continue;
      const label = (l.scope && ((l.scope.model && l.scope.model.display_name) || l.scope.surface)) || null;
      const w = window_({ utilization: l.percent, resets_at: l.resets_at });
      if (!label || !w || seen.has(label)) continue;
      seen.add(label);
      models.push({ label: String(label), ...w });
    }
    // Older per-model fields, for accounts still served them.
    for (const [key, label] of Object.entries(MODEL_BUCKETS)) {
      const w = window_(raw[key]);
      if (w && !seen.has(label)) {
        seen.add(label);
        models.push({ label, ...w });
      }
    }
    if (!session && !weekly && !models.length) return null;
    return { session, weekly, models };
  }

  /** "ok" under 80 %, "warn" from 80 %, "max" at 100 %. */
  function level(p) {
    if (p == null) return "ok";
    if (p >= 100) return "max";
    if (p >= 80) return "warn";
    return "ok";
  }

  /** "2h 14m", "38m", "3d 4h", "now". */
  function formatResetIn(resetsAt, now = Date.now()) {
    if (!resetsAt) return "";
    const mins = Math.max(0, Math.round((resetsAt - now) / 60000));
    if (mins <= 0) return "now";
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  /**
   * The warning to show for a session reading, at most once per 5-hour window:
   * `seenKey` is what to remember so the same warning isn't shown twice.
   * @returns {{kind: "warn"|"max", seenKey: string}|null}
   */
  function warningFor(session, alreadySeen) {
    if (!session) return null;
    const kind = level(session.pct);
    if (kind === "ok") return null;
    const seenKey = `${kind}:${session.resetsAt || "?"}`;
    if (alreadySeen === seenKey) return null;
    // A "max" for this window supersedes a "warn" already shown for it.
    if (kind === "warn" && alreadySeen === `max:${session.resetsAt || "?"}`) return null;
    return { kind, seenKey };
  }

  /** The org the user is looking at: the remembered one if still listed, else the first chat org. */
  function pickOrg(orgs, rememberedId) {
    if (!Array.isArray(orgs) || !orgs.length) return null;
    if (rememberedId && orgs.some((o) => o && o.uuid === rememberedId)) return rememberedId;
    const chat = orgs.find((o) => o && Array.isArray(o.capabilities) && o.capabilities.includes("chat"));
    return (chat || orgs[0]).uuid || null;
  }

  // ── This chat's size (v1.16, merged in from the Usage Meter extension) ────
  // claude.ai exposes no token counts, so this is an estimate: ~4 characters
  // per token, the usual English rule of thumb, always labelled "≈". It is the
  // context a chat re-sends with every message, which is what makes long chats
  // eat a session limit faster.
  const LONG_CHAT_TOKENS = 40000;

  function estimateTokens(chars) {
    const n = Number(chars);
    return Number.isFinite(n) && n > 0 ? Math.round(n / 4) : 0;
  }

  /** 950 → "950", 4420 → "4.4k", 125000 → "125k", 2.3M → "2.3M". */
  function formatCompact(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 1e6) {
      const k = v / 1000;
      return `${k < 10 ? Math.round(k * 10) / 10 : Math.round(k)}k`;
    }
    const m = v / 1e6;
    return `${m < 10 ? Math.round(m * 10) / 10 : Math.round(m)}M`;
  }

  /** { tokens, messages, long } for a transcript, given chat-format's markdown renderer. */
  function chatSize(transcript, toMarkdown) {
    const messages = transcript && Array.isArray(transcript.chat_messages) ? transcript.chat_messages.length : 0;
    const tokens = estimateTokens(String(toMarkdown(transcript) || "").length);
    return { tokens, messages, long: tokens >= LONG_CHAT_TOKENS };
  }

  return { parseUsage, level, formatResetIn, warningFor, pickOrg, estimateTokens, formatCompact, chatSize, LONG_CHAT_TOKENS };
});
