// print/print.js — "Save as PDF" (v1.17).
//
// Opened in a new tab by every PDF entry point, with ids only:
//   print.html?chat=<uuid>[&org=<uuid>]                one chat
//   print.html?project=<uuid>[&org=<uuid>]             every chat in a project
//   print.html?chats=<uuid>,<uuid>…[&org=<uuid>][&title=…]   a Library selection
//
// It fetches the transcripts itself (plain GETs with the browser's claude.ai
// cookies, as the Library does), lays them out with lib/chat-print.js, and
// opens Chrome's print dialog. Limits are checked by the caller before the tab
// opens; this page only reads.
(function () {
  "use strict";

  const api = window.ClaudeApi;
  const P = window.CpdChatPrint;
  const F = window.CpdChatFormat;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const UUID = /^[0-9a-f-]{36}$/i;
  // A chat id or a Cowork task id (cse_…) — fetchTranscript routes on the shape.
  const COWORK = /^cse_[0-9A-Za-z_]+$/;
  const CHAT_ID = { test: (id) => UUID.test(id) || COWORK.test(id) };
  const CONCURRENCY = 2;
  const GAP_MS = 200;

  const status = (text, isError) => {
    $("barStatus").textContent = text;
    $("barStatus").classList.toggle("error", !!isError);
  };
  const progress = (done, total) => {
    $("progressFill").style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
  };

  async function getJson(url) {
    const res = await api.authenticatedGet(url);
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("signed_out"), { code: "signed_out" });
    if (!res.ok) throw new Error(`Claude answered ${res.status}`);
    return api.safeJsonParse(await res.text());
  }

  async function resolveOrg(path) {
    const hint = params.get("org");
    return api.findOwningOrg(path, hint ? [hint] : []);
  }

  // Cowork tasks aren't chat_conversations, so findOwningOrg can't probe them;
  // the org the page was opened with is the one to use.
  async function resolveChatOrg(id) {
    if (COWORK.test(id)) return params.get("org") || (await api.fetchActiveOrgId());
    return resolveOrg(`/chat_conversations/${id}`);
  }

  async function projectChats(orgId, projectId) {
    const cowork = await api.fetchProjectCoworkSessions(orgId, projectId).catch(() => []);
    return [...(await projectConversations(orgId, projectId)), ...cowork];
  }

  async function projectConversations(orgId, projectId) {
    const rows = await api.fetchProjectConversations(orgId, projectId);
    if (rows) return rows;
    // Fallback: the account-wide listing, filtered (same as content.js).
    const all = [];
    for (let offset = 0, page = 0; page < 100; page += 1) {
      const batch = await getJson(`${api.CLAUDE_ORIGIN}/api/organizations/${orgId}/chat_conversations?limit=100&offset=${offset}`);
      if (!Array.isArray(batch) || !batch.length) break;
      all.push(...batch);
      offset += batch.length;
    }
    return all.filter((c) => c && c.project_uuid === projectId);
  }

  async function fetchAll(orgId, ids) {
    const out = new Array(ids.length);
    let next = 0;
    let done = 0;
    let failed = 0;
    async function worker() {
      while (next < ids.length) {
        const i = next++;
        try {
          out[i] = await api.fetchTranscript(orgId, ids[i]);
        } catch (e) {
          failed += 1;
          console.warn("[Claude DL] PDF: transcript failed", ids[i], e);
        }
        done += 1;
        progress(done, ids.length);
        status(`Fetching chats from Claude… ${done} of ${ids.length}`);
        await api.sleep(GAP_MS);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return { transcripts: out.filter(Boolean), failed };
  }

  // Chrome names the PDF after the page title.
  function fileTitle(name) {
    return String(name || "Claude chat").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Claude chat";
  }

  async function run() {
    const chat = params.get("chat");
    const project = params.get("project");
    const chats = (params.get("chats") || "").split(",").filter((id) => CHAT_ID.test(id));

    let orgId;
    let ids;
    let title;
    if (chat && CHAT_ID.test(chat)) {
      orgId = await resolveChatOrg(chat);
      ids = [chat];
    } else if (project && UUID.test(project)) {
      orgId = await resolveOrg(`/projects/${project}`);
      status("Listing the project's chats…");
      const [meta, rows] = await Promise.all([
        getJson(`${api.CLAUDE_ORIGIN}/api/organizations/${orgId}/projects/${project}`).catch(() => null),
        projectChats(orgId, project),
      ]);
      // Oldest first reads like a story; Claude lists newest first.
      ids = rows
        .slice()
        .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
        .map((c) => c.uuid);
      title = (meta && meta.name) || "Claude project";
    } else if (chats.length) {
      orgId = await resolveChatOrg(chats[0]);
      ids = chats;
      title = params.get("title") || `${chats.length} Claude chats`;
    } else {
      throw new Error("Nothing to print: this page needs a chat or project id.");
    }
    if (!orgId) throw Object.assign(new Error("signed_out"), { code: "signed_out" });
    if (!ids.length) throw new Error("This project has no chats yet.");

    const { transcripts, failed } = await fetchAll(orgId, ids);
    if (!transcripts.length) throw new Error("Couldn't load any of the chats. Reload claude.ai and try again.");

    if (!title) title = transcripts[0].name || "Claude chat";
    $("doc").innerHTML = P.transcriptsToDocument(transcripts, F, { title });
    document.title = fileTitle(title);
    $("barTitle").textContent = title;
    status(
      `${transcripts.length} chat${transcripts.length === 1 ? "" : "s"} ready` +
        (failed ? ` · ${failed} couldn't be loaded and ${failed === 1 ? "is" : "are"} left out` : "")
    );
    $("printBtn").disabled = false;
    $("hint").hidden = false;

    // Let fonts settle so the first page isn't laid out in a fallback face.
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    requestAnimationFrame(() => setTimeout(() => window.print(), 150));
  }

  $("printBtn").addEventListener("click", () => window.print());
  $("closeBtn").addEventListener("click", () => window.close());

  run().catch((e) => {
    console.error("[Claude DL] PDF failed:", e);
    progress(0, 0);
    $("barTitle").textContent = "Couldn't make the PDF";
    status(
      e && e.code === "signed_out"
        ? "Sign in to claude.ai in this browser, then try again."
        : (e && e.message) || "Something went wrong.",
      true
    );
  });
})();
