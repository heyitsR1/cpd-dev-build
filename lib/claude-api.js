// Shared Claude API helpers used by both content scripts.
// Loaded as a content-script global and as a CommonJS module (Node tests).
//
// The pure parsers (parseChatIdFromPath / parseOrgIdFromCookie) are separated
// from the fetching so they can be unit-tested without a DOM or network.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node / tests
  } else {
    // Content-script isolated world: expose as a single namespace so the two
    // content scripts don't fight over top-level names.
    root.ClaudeApi = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CLAUDE_ORIGIN = "https://claude.ai";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const COWORK_ID_RE = /^cse_[0-9A-Za-z_]+$/;

  /**
   * The chat uuid from a claude.ai page path, or null when the page isn't a
   * single chat. Standalone chats and project chats share the /chat/{uuid}
   * shape, so this is true for both — which is the point: the in-page button
   * works wherever a transcript is open.
   * @param {string} pathname
   * @returns {string|null}
   */
  function parseChatIdFromPath(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean);
    // A Cowork task page, /cowork/{cse_id}. Its transcript comes from the
    // sessions API instead — fetchTranscript routes on the id's shape.
    if (parts[0] === "cowork" && COWORK_ID_RE.test(parts[1] || "")) return parts[1];
    const idx = parts.indexOf("chat");
    if (idx < 0) return null;
    const id = parts[idx + 1];
    return id && UUID_RE.test(id) ? id : null;
  }

  /**
   * Claude's frontend keeps the active org id in the non-httpOnly lastActiveOrg
   * cookie. On a /chat/{uuid} page this is the only org source that always
   * works — the resource-timing buffer may hold no /api/organizations/... entry
   * at all after a soft navigation.
   * @param {string} cookieString document.cookie
   * @returns {string|null}
   */
  function parseOrgIdFromCookie(cookieString) {
    const m = String(cookieString || "").match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]) || null;
    } catch {
      return m[1] || null;
    }
  }

  function segmentAfter(parts, name) {
    const idx = parts.indexOf(name);
    if (idx < 0) return null;
    return parts[idx + 1] || null;
  }

  /**
   * { orgId, projectId } from a claude.ai page path or an API path.
   * Handles both `/projects/{id}` (API) and `/project/{id}` (page URL —
   * singular). Either field is null when the path doesn't carry it; a page URL
   * never carries an org id.
   * @param {string} pathname
   * @returns {{orgId: string|null, projectId: string|null}}
   */
  function parseOrgProjectFromPath(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean);
    return {
      orgId: segmentAfter(parts, "organizations"),
      projectId: segmentAfter(parts, "projects") || segmentAfter(parts, "project"),
    };
  }

  /**
   * Same, for an absolute URL (a resource-timing entry). Null when the URL
   * doesn't parse or names no project.
   * @param {string} url
   * @returns {{orgId: string|null, projectId: string|null}|null}
   */
  function parseOrgProjectFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = parseOrgProjectFromPath(new URL(url).pathname);
      return parsed.projectId ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Decide which project an export belongs to.
   *
   * **The current path always wins over the resource-timing buffer.** The
   * buffer is not a trustworthy source of "which project am I looking at":
   *
   *  - claude.ai is an SPA, so navigating project A → project B never clears
   *    it, and Claude often serves B from its client cache without ever
   *    re-requesting B's /docs or /files. The newest matching entry stays A's.
   *  - The buffer caps at ~250 resource entries and then silently stops
   *    recording. On a long session it holds only the *earliest* requests — so
   *    the entry we find is the first project the tab ever opened.
   *
   * Preferring it exported the wrong project's chats and files: the customer
   * selected one project and got another one's conversations, which read as
   * "it just downloaded my sidebar chats".
   *
   * The buffer is still useful for the org id (org-level, so staleness is
   * near-harmless) and as the last resort for a project id when the path has
   * none.
   *
   * @param {{pathname?: string, perfUrl?: string|null, fallbackOrgId?: string|null}} input
   * @returns {{orgId: string|null, projectId: string|null}}
   */
  function resolveOrgProject(input) {
    const { pathname, perfUrl, fallbackOrgId } = input || {};
    const fromPath = parseOrgProjectFromPath(pathname);
    const fromPerf = parseOrgProjectFromUrl(perfUrl);
    const perfOrgId = fromPerf ? fromPerf.orgId : null;

    // The path names a project → that is the answer, full stop. Only the org
    // id may be borrowed from elsewhere, since /project/{id} carries none.
    // When the buffer holds the page's own request for *this* project, its org
    // is proof; the lastActiveOrg cookie is only a hint and can be stale.
    if (fromPath.projectId) {
      const perfSameProject = fromPerf && fromPerf.projectId === fromPath.projectId ? perfOrgId : null;
      return {
        orgId: fromPath.orgId || perfSameProject || fallbackOrgId || perfOrgId || null,
        projectId: fromPath.projectId,
      };
    }

    // No project in the path — the buffer is all that's left.
    if (fromPerf && fromPerf.projectId) {
      return {
        orgId: perfOrgId || fallbackOrgId || null,
        projectId: fromPerf.projectId,
      };
    }

    return { orgId: fromPath.orgId || fallbackOrgId || null, projectId: null };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Authenticated GET using page cookies. Retries once after a back-off on HTTP
  // 429 so a single rate-limit hit doesn't abort an export.
  async function authenticatedGet(url) {
    const opts = {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json, text/plain, */*" },
      cache: "no-store",
    };
    let res = await fetch(url, opts);
    if (res.status === 429) {
      await sleep(1500);
      res = await fetch(url, opts);
    }
    return res;
  }

  // Fetch one full transcript.
  //
  // `render_all_tools=true` is load-bearing. Without it the server rewrites every
  // tool block (artifacts, file creation, web search) into a text block reading
  // "This block is not supported on your current device yet." — which then landed
  // verbatim in exported markdown while the artifact itself vanished. Customers
  // reported this as "some artifacts don't download"; it affected every chat where
  // Claude used a tool. Do not drop this parameter.
  async function fetchTranscript(orgId, convUuid) {
    if (COWORK_ID_RE.test(String(convUuid || ""))) return fetchCoworkTranscript(orgId, convUuid);
    const url =
      `${CLAUDE_ORIGIN}/api/organizations/${orgId}/chat_conversations/${convUuid}` +
      `?tree=True&rendering_mode=messages&render_all_tools=true`;
    const res = await authenticatedGet(url);
    if (!res.ok) throw new Error(`Transcript ${convUuid} failed (${res.status})`);
    const data = safeJsonParse(await res.text());
    if (!data || typeof data !== "object") {
      throw new Error(`Transcript ${convUuid} was not an object.`);
    }
    return data;
  }

  /**
   * Every conversation in one project, from the project's own listing:
   *   GET /api/organizations/{org}/projects/{project}/conversations_v2?limit&offset
   *   → { data: [...], pagination: { total, limit, offset, has_more } }
   *
   * This is what claude.ai's project page itself reads. The older route listed
   * the whole account through /chat_conversations and filtered by
   * project_uuid, so its cost grew with the account rather than the project
   * and any listing quirk on a large account (a page cap, a row without
   * project_uuid) silently dropped project chats — reported 2026-10-01 as "pro
   * version doesn't recognize all the chats in a project. Lucky if it gets one."
   *
   * Returns null when the endpoint doesn't answer in the expected shape, so the
   * caller can fall back to the account-wide listing rather than export nothing.
   *
   * @param {string} orgId
   * @param {string} projectId
   * @param {(url: string) => Promise<any>} [getJson] injectable for tests
   * @returns {Promise<object[]|null>}
   */
  async function fetchProjectConversations(orgId, projectId, getJson) {
    const load = getJson || (async (url) => {
      const res = await authenticatedGet(url);
      if (!res.ok) throw new Error(`Project conversations failed (${res.status})`);
      return safeJsonParse(await res.text());
    });
    const limit = 100;
    const all = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < 200; page += 1) {
      const url =
        `${CLAUDE_ORIGIN}/api/organizations/${orgId}/projects/${projectId}/conversations_v2` +
        `?limit=${limit}&offset=${offset}`;
      let body;
      try {
        body = await load(url);
      } catch (err) {
        // A failure on the first page means "use the fallback"; a failure
        // after that is a real error — don't hand back half a project as if
        // it were all of it.
        if (page === 0) return null;
        throw err;
      }
      const rows = body && Array.isArray(body.data) ? body.data : null;
      if (!rows) return page === 0 ? null : all;
      let added = 0;
      for (const c of rows) {
        if (!c || !c.uuid || seen.has(c.uuid)) continue;
        seen.add(c.uuid);
        all.push(c);
        added += 1;
      }
      const more = body.pagination ? body.pagination.has_more === true : rows.length >= limit;
      if (!more || rows.length === 0 || added === 0) break;
      offset += rows.length;
    }
    return all;
  }

  // ── Cowork tasks ─────────────────────────────────────────────────────────
  //
  // Cowork tasks (/cowork/{cse_id}) are not chat_conversations. They live in
  // the sessions API claude.ai's own Cowork view reads:
  //   GET /v1/code/sessions?tags=cowork-remote&chat_project_id={claude_proj_…}
  //   GET /v1/code/sessions/{cse_id}                → { response_shape: {title, …} }
  //   GET /v1/code/sessions/{cse_id}/events?limit&cursor → { data, next_cursor }
  // A project's /conversations_v2 does not list them, which is why a project
  // of only Cowork tasks exported as "0 chats" (reported 2026-10-12).
  //
  // Sessions tagged bard-e1-force-upgrade were turned into ordinary
  // conversations and already appear in /conversations_v2; they're skipped
  // here so they don't export twice. claude.ai's own list skips them too.

  const COWORK_TAG = "cowork-remote";
  const COWORK_UPGRADED_TAG = "bard-e1-force-upgrade";
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  /**
   * A uuid as the sessions API's tagged id: `${tag}_01` + 22 base58 digits of
   * the 128-bit value. Mirrors claude.ai's decoder; `claude_proj_011CfBMBRSSK…`
   * is project 01a0b5b2-5a0c-…
   * @param {string} tag e.g. "claude_proj"
   * @param {string} uuid
   * @returns {string|null}
   */
  function encodeTaggedId(tag, uuid) {
    if (!UUID_RE.test(String(uuid || ""))) return null;
    let n = BigInt(`0x${uuid.replace(/-/g, "")}`);
    let digits = "";
    while (n > 0n) {
      digits = B58[Number(n % 58n)] + digits;
      n /= 58n;
    }
    return `${tag}_01${digits.padStart(22, "1")}`;
  }

  function coworkGetter(orgId) {
    return async (url) => {
      const opts = {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          ...(orgId ? { "x-organization-uuid": orgId } : {}),
        },
      };
      let res = await fetch(url, opts);
      if (res.status === 429) {
        await sleep(1500);
        res = await fetch(url, opts);
      }
      if (!res.ok) throw new Error(`Cowork request failed (${res.status})`);
      return safeJsonParse(await res.text());
    };
  }

  /**
   * The Cowork tasks in one project, shaped like conversation rows
   * ({ uuid, name, created_at, updated_at, kind: "cowork" }) so the chat
   * listing and export code take them as they are.
   * @param {string} orgId
   * @param {string} projectId project uuid
   * @param {(url: string) => Promise<any>} [getJson] injectable for tests
   * @returns {Promise<object[]>}
   */
  async function fetchProjectCoworkSessions(orgId, projectId, getJson) {
    const tagged = encodeTaggedId("claude_proj", projectId);
    if (!tagged) return [];
    const load = getJson || coworkGetter(orgId);
    const rows = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      const url =
        `${CLAUDE_ORIGIN}/v1/code/sessions?tags=${COWORK_TAG}&chat_project_id=${tagged}` +
        `&include_trigger_sessions=true&limit=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const body = await load(url);
      const data = body && Array.isArray(body.data) ? body.data : [];
      for (const s of data) {
        if (!s || !COWORK_ID_RE.test(String(s.id || "")) || seen.has(s.id)) continue;
        if (Array.isArray(s.tags) && s.tags.includes(COWORK_UPGRADED_TAG)) continue;
        seen.add(s.id);
        rows.push({
          uuid: s.id,
          name: s.title || "Untitled task",
          created_at: s.created_at || null,
          updated_at: s.last_event_at || s.updated_at || null,
          kind: "cowork",
        });
      }
      cursor = body && body.next_cursor;
      if (!cursor || data.length === 0) break;
    }
    return rows;
  }

  // Tool results carry screenshots as base64; keep their text only.
  function slimToolResult(block) {
    const items =
      typeof block.content === "string"
        ? [{ type: "text", text: block.content }]
        : Array.isArray(block.content)
          ? block.content.filter((i) => i && i.type === "text")
          : [];
    return { type: "tool_result", tool_use_id: block.tool_use_id, is_error: !!block.is_error, content: items };
  }

  // claude.ai injects context as user turns — device access, computer use,
  // the user's timezone — each wrapped in <system-reminder>. The person never
  // typed them, so they don't belong in the export as "Human" messages.
  function stripReminders(block) {
    if (!block || block.type !== "text" || typeof block.text !== "string") return block;
    const text = block.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    return text ? { ...block, text } : null;
  }

  function slimBlock(block) {
    if (!block || typeof block !== "object") return null;
    if (block.type === "image" || block.type === "document") return { type: block.type };
    if (block.type === "tool_result") return slimToolResult(block);
    return block;
  }

  /**
   * Session events → the transcript shape the chat formatters already read
   * ({ uuid, name, chat_messages: [{ sender, created_at, content }] }).
   *
   * Events arrive newest-first; sequence_num (a string) orders them. Only
   * typed user turns become "human" messages — tool results and Claude's
   * blocks fold into the running assistant turn, the way a claude.ai chat
   * transcript groups them. Sub-agent internals and synthetic turns (context
   * summaries after a compaction) are left out.
   * @param {object|null} meta response_shape of GET /v1/code/sessions/{id}
   * @param {object[]} events
   * @param {string} sessionId
   * @returns {object}
   */
  function coworkEventsToTranscript(meta, events, sessionId) {
    const sorted = (Array.isArray(events) ? events : [])
      .filter((e) => e && e.payload && typeof e.payload === "object")
      .sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num));
    const messages = [];
    let current = null;
    const start = (sender, p, e) => {
      current = { uuid: p.uuid || e.event_id || "", sender, created_at: p.timestamp || e.created_at || null, content: [] };
      messages.push(current);
      return current;
    };

    for (const e of sorted) {
      const p = e.payload;
      if (p.parent_tool_use_id || p.isSynthetic || p.isMeta) continue;
      const raw = p.message && p.message.content;
      const blocks = typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? raw : [];

      if (p.type === "user") {
        const results = blocks.filter((b) => b && b.type === "tool_result");
        const typed = blocks.filter((b) => b && b.type !== "tool_result").map(stripReminders).filter(Boolean);
        if (results.length && current && current.sender === "assistant") {
          current.content.push(...results.map(slimToolResult));
        }
        if (typed.length) start("human", p, e).content.push(...typed.map(slimBlock).filter(Boolean));
      } else if (p.type === "assistant") {
        if (!current || current.sender !== "assistant") start("assistant", p, e);
        current.content.push(...blocks.map(slimBlock).filter(Boolean));
      }
    }

    // A text-only `text` field too: some exporters (PDF, context estimate)
    // read it before the blocks.
    for (const m of messages) {
      m.text = m.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n\n");
    }

    return {
      uuid: sessionId,
      name: (meta && meta.title) || "",
      created_at: (meta && meta.created_at) || null,
      updated_at: (meta && (meta.last_event_at || meta.updated_at)) || null,
      kind: "cowork",
      chat_messages: messages,
    };
  }

  /**
   * One Cowork task's full transcript.
   * @param {string} orgId
   * @param {string} sessionId cse_…
   * @param {(url: string) => Promise<any>} [getJson] injectable for tests
   */
  async function fetchCoworkTranscript(orgId, sessionId, getJson) {
    const load = getJson || coworkGetter(orgId);
    const base = `${CLAUDE_ORIGIN}/v1/code/sessions/${encodeURIComponent(sessionId)}`;
    const metaBody = await load(base).catch(() => null);
    const events = [];
    let cursor = null;
    for (let page = 0; page < 200; page += 1) {
      const body = await load(
        `${base}/events?limit=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
      );
      if (body && Array.isArray(body.data)) events.push(...body.data);
      cursor = body && body.next_cursor;
      if (!cursor || !body || !Array.isArray(body.data) || body.data.length === 0) break;
    }
    if (!metaBody && events.length === 0) throw new Error(`Cowork task ${sessionId} could not be loaded.`);
    return coworkEventsToTranscript(metaBody && metaBody.response_shape, events, sessionId);
  }

  /**
   * The Cowork task behind a /chat/{uuid} page that isn't a chat.
   *
   * Where Cowork is merged into chat, opening /cowork/{cse_id} redirects to
   * /chat/{uuid}, and that uuid is unknown to chat_conversations (404) and to
   * the sessions API — claude.ai resolves it some way we can't see (checked
   * 2026-10-12). Two clues remain on the page:
   *   1. navLog — claude.ai's own sessionStorage "spa_nav_loop" records the
   *      /cowork/{cse_id} load right before the /chat/{uuid} one. Exact.
   *   2. title — the tab title is the task's title. Newest match wins.
   * @param {string} orgId
   * @param {{chatUuid: string, navLog?: string|null, title?: string}} page
   * @param {(url: string) => Promise<any>} [getJson] injectable for tests
   * @returns {Promise<string|null>} cse_ id
   */
  async function resolveCoworkForChat(orgId, page, getJson) {
    const { chatUuid, navLog, title } = page || {};
    try {
      const loads = (safeJsonParse(navLog || "") || {}).loads || [];
      for (let i = loads.length - 1; i > 0; i -= 1) {
        if (loads[i] && loads[i].p === `/chat/${chatUuid}`) {
          const m = String((loads[i - 1] && loads[i - 1].p) || "").match(/^\/cowork\/(cse_[0-9A-Za-z_]+)/);
          if (m) return m[1];
        }
      }
    } catch {
      /* fall through to the title */
    }
    const want = String(title || "").replace(/\s*[-–|]\s*Claude\s*$/i, "").trim();
    if (!want) return null;
    const load = getJson || coworkGetter(orgId);
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const body = await load(
        `${CLAUDE_ORIGIN}/v1/code/sessions?tags=${COWORK_TAG}&limit=100` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
      );
      const data = body && Array.isArray(body.data) ? body.data : [];
      // The list is newest first, so the first title match is the latest.
      const hit = data.find((s) => s && String(s.title || "").trim() === want);
      if (hit) return hit.id;
      cursor = body && body.next_cursor;
      if (!cursor || data.length === 0) break;
    }
    return null;
  }

  const ownerCache = new Map();

  /**
   * The org that owns a resource (`/projects/{id}`, `/chat_conversations/{id}`).
   *
   * The lastActiveOrg cookie is a hint, not proof: after an org switch in
   * another tab, a Console visit, or on a Team + personal account it can name
   * an org that doesn't hold the project on screen. Every call under the wrong
   * org 404s, which the popup showed as the project id in place of its name
   * and "no chats" (reported 2026-10-09, v1.16.0).
   *
   * Probes the preferred orgs in order, then every org on the account, and
   * caches the first that answers 200. Only 403/404 moves on — a 429 or 500
   * says nothing about ownership, so the preferred org is kept. When nothing
   * owns it, the first preferred org is returned so callers fail as before.
   *
   * @param {string} resourcePath path under /api/organizations/{org}
   * @param {(string|null)[]} preferredOrgIds
   * @param {{status?: (url: string) => Promise<number>, listOrgs?: () => Promise<object[]>, cache?: Map}} [deps]
   * @returns {Promise<string|null>}
   */
  async function findOwningOrg(resourcePath, preferredOrgIds, deps) {
    const d = deps || {};
    const cache = d.cache || ownerCache;
    if (cache.has(resourcePath)) return cache.get(resourcePath);

    const status = d.status || (async (url) => {
      try {
        return (await authenticatedGet(url)).status;
      } catch {
        return 0;
      }
    });
    const listOrgs = d.listOrgs || (async () => {
      const res = await authenticatedGet(`${CLAUDE_ORIGIN}/api/organizations`);
      const orgs = res.ok ? safeJsonParse(await res.text()) : null;
      return Array.isArray(orgs) ? orgs : [];
    });

    const preferred = (preferredOrgIds || []).filter(Boolean);
    const fallback = preferred[0] || null;
    const tried = new Set();

    const probe = async (orgId) => {
      tried.add(orgId);
      const code = await status(`${CLAUDE_ORIGIN}/api/organizations/${orgId}${resourcePath}`);
      if (code >= 200 && code < 300) return "owner";
      return code === 403 || code === 404 ? "not-here" : "unknown";
    };

    for (const orgId of preferred) {
      if (tried.has(orgId)) continue;
      const verdict = await probe(orgId);
      if (verdict === "owner") {
        cache.set(resourcePath, orgId);
        return orgId;
      }
      if (verdict === "unknown") return orgId;
    }

    let orgs = [];
    try {
      orgs = await listOrgs();
    } catch {
      /* keep the fallback */
    }
    for (const o of orgs) {
      const orgId = o && o.uuid;
      if (!orgId || tried.has(orgId)) continue;
      if ((await probe(orgId)) === "owner") {
        console.info(`[Claude DL] ${resourcePath} lives in org ${orgId}, not the active-org cookie's.`);
        cache.set(resourcePath, orgId);
        return orgId;
      }
    }
    return fallback;
  }

  // Resolve active org ID from cookie or API fallback
  async function fetchActiveOrgId() {
    const fromCookie = parseOrgIdFromCookie(typeof document !== "undefined" ? document.cookie : "");
    if (fromCookie) return fromCookie;

    try {
      const res = await authenticatedGet(`${CLAUDE_ORIGIN}/api/organizations`);
      if (res.ok) {
        const orgs = safeJsonParse(await res.text());
        if (Array.isArray(orgs) && orgs.length > 0 && orgs[0].uuid) {
          return orgs[0].uuid;
        }
      }
    } catch (e) {
      console.warn("[Claude DL] Could not fetch /api/organizations:", e);
    }
    return null;
  }

  return {
    CLAUDE_ORIGIN,
    parseChatIdFromPath,
    parseOrgIdFromCookie,
    parseOrgProjectFromPath,
    parseOrgProjectFromUrl,
    resolveOrgProject,
    fetchActiveOrgId,
    sleep,
    safeJsonParse,
    authenticatedGet,
    fetchTranscript,
    fetchProjectConversations,
    fetchProjectCoworkSessions,
    fetchCoworkTranscript,
    coworkEventsToTranscript,
    resolveCoworkForChat,
    encodeTaggedId,
    findOwningOrg,
  };
});
