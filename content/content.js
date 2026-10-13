(() => {
  "use strict";

  // Idempotency guard. The popup now (re)injects this script on demand via
  // chrome.scripting.executeScript so a tab that was open *before* the extension
  // was installed/updated still works. Re-injection lands in the same isolated
  // world, so this flag prevents registering the onMessage listeners twice
  // (which would double-call sendResponse and trigger "message port closed").
  if (window.__CLAUDE_DL_CONTENT_LOADED__) return;
  window.__CLAUDE_DL_CONTENT_LOADED__ = true;

  /**
   * Claude Project Files Downloader - content script
   *
   * Responsibilities:
   * 1) Find the Claude docs endpoint URL from performance entries or current URL context.
   * 2) Fetch docs JSON with page cookies/credentials.
   * 3) Return docs back to popup via runtime messaging.
   */

  const MESSAGE_TYPE_FETCH = "CLAUDE_DOCS_FETCH";
  const CLAUDE_ORIGIN = "https://claude.ai";

  function isClaudeUrl(url) {
    return typeof url === "string" && /^https:\/\/claude\.ai\//i.test(url);
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Path/URL → { orgId, projectId } now lives in lib/claude-api.js as the one
  // source of truth (parseOrgProjectFromPath / parseOrgProjectFromUrl). A
  // second copy here is how the perf-entries-win-over-the-URL bug got in.

  function findDocsUrlFromPerformanceEntries() {
    try {
      const entries = performance.getEntriesByType("resource");
      if (!Array.isArray(entries) || !entries.length) return null;

      // Look for /api/organizations/{orgId}/projects/{projectId}/docs or /files
      const pattern = /^https:\/\/claude\.ai\/api\/organizations\/[^/]+\/projects\/[^/]+\/(docs|files)(?:\?|$)/i;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const name = entries[i] && entries[i].name;
        if (typeof name === "string" && pattern.test(name)) {
          return name;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Try to discover orgId from any performance entry containing /api/{orgId}/files/
   * This covers cases where Claude's frontend only hit file-specific URLs (thumbnails, etc.)
   */
  function findOrgIdFromPerformanceEntries() {
    try {
      const entries = performance.getEntriesByType("resource");
      if (!Array.isArray(entries) || !entries.length) return null;

      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const name = entries[i] && entries[i].name;
        if (typeof name !== "string" || !isClaudeUrl(name)) continue;

        // Match /api/{orgId}/files/ pattern (used for thumbnails, previews)
        const m = name.match(/\/api\/([0-9a-f-]{36})\/files\//i);
        if (m) return m[1];

        // Match /api/organizations/{orgId}/ pattern
        const m2 = name.match(/\/api\/organizations\/([0-9a-f-]{36})/i);
        if (m2) return m2[1];
      }

      return null;
    } catch {
      return null;
    }
  }

  // Claude's frontend stores the active org id in the (non-httpOnly) lastActiveOrg
  // cookie. This is the most reliable orgId source: it does not depend on the
  // resource-timing buffer still holding an /api/... entry, which is empty on a
  // freshly-loaded /project/{id} page or after the buffer has been cleared.
  function findOrgIdFromCookie() {
    try {
      return window.ClaudeApi.parseOrgIdFromCookie(document.cookie);
    } catch {
      return null;
    }
  }

  async function fetchDocsJson(docsUrl) {
    const res = await fetch(docsUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Claude docs request failed (${res.status})`);
    }

    const raw = await res.text();
    const data = safeJsonParse(raw);

    if (!Array.isArray(data)) {
      throw new Error("Claude docs response was not an array.");
    }

    // Normalize shape and keep only relevant fields.
    const docs = data
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        uuid: item.uuid ?? "",
        file_name: item.file_name ?? "untitled.md",
        content: item.content ?? "",
        created_at: item.created_at ?? "",
        project_uuid: item.project_uuid ?? "",
        estimated_token_count:
          typeof item.estimated_token_count === "number" ? item.estimated_token_count : null,
      }));

    return docs;
  }

  async function fetchFilesJson(filesUrl) {
    const res = await fetch(filesUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      if (res.status === 404) return []; // Old projects might not have standard files endpoint
      throw new Error(`Claude files request failed (${res.status})`);
    }

    const raw = await res.text();
    const data = safeJsonParse(raw);

    if (!Array.isArray(data)) {
      throw new Error("Claude files response was not an array.");
    }

    // Normalize shape for binary files (documents, images, and raw blobs).
    const files = data
      .filter((item) => {
        if (!item || typeof item !== "object") return false;
        // Documents (PDFs, etc.) have document_asset
        if (item.document_asset && item.document_asset.url) return true;
        // Images have preview_asset (the full-res version)
        if (item.file_kind === "image" && item.preview_asset && item.preview_asset.url) return true;
        // Raw blobs (xlsx, etc.) – served directly from a predictable files URL
        if (item.file_kind === "blob" && item.file_uuid) return true;
        return false;
      })
      .map((item) => {
        let downloadUrl;
        let fileName = item.file_name ?? "untitled.bin";

        if (item.file_kind === "image") {
          // Preview endpoint always serves WebP regardless of original format.
          // Rename the extension so the saved file opens correctly.
          downloadUrl = item.preview_asset.url;
          fileName = fileName.replace(/\.(png|jpe?g|gif|bmp|tiff|webp)$/i, ".webp");
        } else if (item.file_kind === "blob") {
          // Blobs (xlsx, zip, etc.) have no asset URL in the JSON.
          // Extract orgId from the filesUrl we already have (e.g. /api/organizations/{orgId}/projects/.../files)
          const orgMatch = filesUrl.match(/\/api\//);
          // filesUrl is like: https://claude.ai/api/organizations/{orgId}/projects/{projectId}/files
          // We parse orgId from it directly
          const urlParts = new URL(filesUrl).pathname.split("/").filter(Boolean);
          const orgIdx = urlParts.indexOf("organizations");
          const orgId = orgIdx >= 0 ? urlParts[orgIdx + 1] : null;

          if (orgId) {
            downloadUrl = `/api/${orgId}/files/${item.file_uuid}/content`;
          } else {
            downloadUrl = null;
          }
        } else {
          // Documents (PDFs)
          downloadUrl = item.document_asset.url;
        }

        return {
          uuid: item.uuid ?? "",
          file_name: fileName,
          content: null,
          download_url: downloadUrl,
          created_at: item.created_at ?? "",
          project_uuid: item.project_uuid ?? item.project_id ?? "",
          estimated_token_count: item.document_asset?.token_count ?? null,
          // For the context meter (popup/context-meter.js).
          page_count: item.document_asset?.page_count ?? null,
          size_bytes: typeof item.size_bytes === "number" ? item.size_bytes : null,
          file_kind: item.file_kind ?? "document",
        };
      })
      .filter((item) => item.download_url !== null); // Drop blobs we couldn't resolve

    return files;
  }

  // The project's own record — carries the Instructions panel (`prompt_template`)
  // and the blurb under the title (`description`). Both live only here; the
  // Instructions UI is a modal, so there's no page to scrape them from.
  async function fetchProjectMeta(projectUrl) {
    const res = await fetch(projectUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Claude project request failed (${res.status})`);
    }

    const data = safeJsonParse(await res.text());
    if (!data || typeof data !== "object") {
      throw new Error("Claude project response was not an object.");
    }

    return {
      name: typeof data.name === "string" ? data.name : "",
      description: typeof data.description === "string" ? data.description : "",
      instructions: typeof data.prompt_template === "string" ? data.prompt_template : "",
      created_at: data.created_at ?? "",
      updated_at: data.updated_at ?? "",
    };
  }

  async function resolveOrgId() {
    const fromCookie = findOrgIdFromCookie();
    if (fromCookie) return fromCookie;
    const fromPerf = findOrgIdFromPerformanceEntries();
    if (fromPerf) return fromPerf;
    if (window.ClaudeApi && window.ClaudeApi.fetchActiveOrgId) {
      return await window.ClaudeApi.fetchActiveOrgId();
    }
    return null;
  }

  // { orgId, projectId } for whatever the tab is showing right now. Either may
  // be null. The pure decision lives in lib/claude-api.js so it can be tested;
  // this only gathers the three inputs from the live page.
  function resolveOrgProjectForPage(orgIdHint) {
    const shared = api();
    const perfUrl = findDocsUrlFromPerformanceEntries();
    const resolved = shared.resolveOrgProject({
      pathname: window.location.pathname,
      perfUrl,
      fallbackOrgId: orgIdHint || findOrgIdFromCookie() || findOrgIdFromPerformanceEntries(),
    });

    // Leaves a breadcrumb for the exact failure this ordering was written to
    // fix. Before, the stale side won silently and the customer just got
    // another project's chats.
    const fromPerf = shared.parseOrgProjectFromUrl(perfUrl);
    if (fromPerf && resolved.projectId && fromPerf.projectId !== resolved.projectId) {
      console.info(
        `[Claude DL] Ignoring a stale resource-timing entry for project ` +
          `${fromPerf.projectId}; the page is project ${resolved.projectId}.`
      );
    }

    return resolved;
  }

  // Same, with the org checked against the project: the cookie can name an org
  // that doesn't hold this project. See findOwningOrg in lib/claude-api.js.
  async function resolveVerifiedOrgProject(orgIdHint) {
    const resolved = resolveOrgProjectForPage(orgIdHint);
    if (!resolved.projectId) return resolved;
    const orgId = await api().findOwningOrg(`/projects/${resolved.projectId}`, [
      resolved.orgId,
      orgIdHint,
      findOrgIdFromCookie(),
    ]);
    return { orgId, projectId: resolved.projectId };
  }

  async function handleFetchRequest() {
    const orgId = await resolveOrgId();
    const chatId = api().parseChatIdFromPath(window.location.pathname);

    // 1) Check if on a single chat page (/chat/{uuid})
    if (chatId) {
      let transcript = null;
      let chatOrgId = orgId;
      if (orgId) {
        try {
          transcript = await fetchTranscript(orgId, chatId);
        } catch (err) {
          // The cookie's org may not hold this chat — find the one that does.
          const owner = await api().findOwningOrg(`/chat_conversations/${chatId}`, [orgId]);
          if (owner && owner !== orgId) {
            try {
              transcript = await fetchTranscript(owner, chatId);
              chatOrgId = owner;
            } catch (retryErr) {
              console.warn("[Claude DL] Could not load active chat transcript:", retryErr);
            }
          } else {
            console.warn("[Claude DL] Could not load active chat transcript:", err);
          }
        }
      }

      // Not a chat: a Cowork task shown at /chat/{uuid} (merged Cowork). Its
      // transcript lives in the sessions API under a cse_ id.
      let exportId = chatId;
      if (!transcript && orgId && !/^cse_/.test(chatId)) {
        try {
          let navLog = null;
          try {
            navLog = sessionStorage.getItem("spa_nav_loop");
          } catch {
            /* storage blocked */
          }
          const cse = await api().resolveCoworkForChat(orgId, { chatUuid: chatId, navLog, title: document.title });
          if (cse) {
            transcript = await fetchTranscript(orgId, cse);
            exportId = cse;
          }
        } catch (err) {
          console.warn("[Claude DL] Could not load this page as a Cowork task:", err);
        }
      }

      const name =
        (transcript && transcript.name) ||
        document.title.replace(/\s*[-–|]\s*Claude\s*$/i, "").trim() ||
        "Untitled chat";
      if (transcript && !transcript.name) transcript.name = name;

      const messageCount = (transcript && Array.isArray(transcript.chat_messages)) ? transcript.chat_messages.length : 0;
      const attachments = (transcript && window.extractChatAttachments) ? window.extractChatAttachments(transcript, chatOrgId) : [];

      return {
        pageType: "chat",
        chat: {
          uuid: exportId,
          name,
          messageCount,
          attachmentCount: attachments.length,
          transcript: transcript || { uuid: chatId, name, chat_messages: [] },
          orgId: chatOrgId || "",
        },
      };
    }

    // 2) Which project is this? The page path wins over the resource-timing
    //    buffer — see resolveOrgProject in lib/claude-api.js for why.
    const orgProject = await resolveVerifiedOrgProject(orgId);

    if (orgProject && orgProject.orgId && orgProject.projectId) {
      const projectUrl = `${CLAUDE_ORIGIN}/api/organizations/${orgProject.orgId}/projects/${orgProject.projectId}`;
      const docsUrl = `${projectUrl}/docs`;
      const filesUrl = `${projectUrl}/files`;

      // Fetch all three endpoints in parallel
      const [docs, files, project] = await Promise.all([
        fetchDocsJson(docsUrl).catch((err) => {
          console.warn("[Claude DL] Could not fetch /docs:", err);
          return [];
        }),
        fetchFilesJson(filesUrl).catch((err) => {
          console.warn("[Claude DL] Could not fetch /files:", err);
          return [];
        }),
        // Non-fatal: a missing project record just means no instructions.md.
        fetchProjectMeta(projectUrl).catch((err) => {
          console.warn("[Claude DL] Could not fetch project metadata:", err);
          return null;
        }),
      ]);

      const combined = [...docs, ...files];
      return {
        pageType: "project",
        docs: combined,
        docsUrl,
        project,
      };
    }

    return {
      pageType: "generic",
      docs: [],
      message: "Please open a Claude chat or project, then click ↺ Refresh.",
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPE_FETCH) return;

    (async () => {
      try {
        const result = await handleFetchRequest();
        sendResponse({
          ok: true,
          ...result,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error while fetching docs.",
        });
      }
    })();

    // Keep message channel open for async response
    return true;
  });

  // ───────────────────────────────────────────────────────────────
  // Project chat export
  // ───────────────────────────────────────────────────────────────
  const MESSAGE_TYPE_CHATS_FETCH = "CLAUDE_CHATS_FETCH";
  const CHATS_PROGRESS_TYPE = "CLAUDE_CHATS_PROGRESS";
  const CHAT_FETCH_CONCURRENCY = 2;
  const CHAT_FETCH_GAP_MS = 200;

  // Shared with content/chat-button.js — see lib/claude-api.js. Resolved
  // lazily on purpose: a top-level `const { … } = window.ClaudeApi` threw when
  // that file hadn't run, and since __CLAUDE_DL_CONTENT_LOADED__ is already set
  // by then, the popup's re-injection could never repair it — the three chat
  // listeners registered below this line simply never existed, so the popup got
  // "Receiving end does not exist" instead of a usable error.
  function api() {
    const shared = window.ClaudeApi;
    if (!shared) {
      throw new Error(
        "The extension's scripts loaded out of order. Reload the Claude tab and try again."
      );
    }
    return shared;
  }

  const sleep = (ms) => api().sleep(ms);
  const authenticatedGet = (url) => api().authenticatedGet(url);
  const fetchTranscript = (orgId, convUuid) => api().fetchTranscript(orgId, convUuid);

  // List every conversation for the org, paging until exhausted.
  // De-dupes by uuid and stops as soon as a page adds no new conversations, so
  // if the endpoint were to ignore `offset` (cursor-style paging) we neither
  // loop 100× nor return 10k duplicates — we just stop. `addedThisPage === 0`
  // in the logs below is the tell-tale that offset paging isn't working.
  async function fetchConversationList(orgId) {
    const all = [];
    const seen = new Set();
    const limit = 100;
    let offset = 0;
    let pages = 0;
    // Hard cap to avoid an infinite loop if the endpoint ignores paging.
    for (let page = 0; page < 100; page += 1) {
      const url =
        `${CLAUDE_ORIGIN}/api/organizations/${orgId}/chat_conversations` +
        `?limit=${limit}&offset=${offset}`;
      const res = await authenticatedGet(url);
      if (!res.ok) throw new Error(`Conversation list failed (${res.status})`);
      const batch = safeJsonParse(await res.text());
      if (!Array.isArray(batch) || batch.length === 0) break;

      let addedThisPage = 0;
      for (const c of batch) {
        const id = c && c.uuid;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(c);
        addedThisPage += 1;
      }
      pages += 1;

      // Endpoint returned only rows we've already seen → offset paging is a
      // no-op here; stop rather than spinning to the 100-page cap.
      if (addedThisPage === 0) break;

      // NB: a short page is *not* proof we've reached the end — the server is
      // free to cap page size below the `limit` we asked for. Breaking on that
      // truncated the list to the most recent page, so a project whose chats
      // were older than that window exported as empty or near-empty. Keep
      // paging until a request returns nothing, or nothing new (above).
      offset += batch.length;
      if (page === 99) {
        console.warn(
          "[Claude DL] Hit the 100-page cap while listing conversations — " +
            "the export may be incomplete."
        );
      }
    }
    console.info(
      `[Claude DL] Fetched ${all.length} conversations across ${pages} page(s).`
    );
    return all;
  }

  function emitChatsProgress(current, total) {
    try {
      chrome.runtime.sendMessage({ type: CHATS_PROGRESS_TYPE, current, total });
    } catch {
      /* popup may be closed; ignore */
    }
  }

  // Resolve { orgId, projectId } for the current tab, or throw a friendly error.
  // Shared by the docs, chat-list, single-chat, and bulk-chat flows.
  async function resolveOrgProject() {
    const orgProject = await resolveVerifiedOrgProject(null);
    if (!orgProject || !orgProject.orgId || !orgProject.projectId) {
      throw new Error(
        "Could not find the Claude project. Open a project page, wait for it to load, then try again. " +
        "For a single chat, use the Download button next to Share on the chat page."
      );
    }
    return orgProject;
  }

  // Lightweight chat listing — names + uuids only, no transcripts. Used by the
  // popup's Refresh to show a chat count and the individual-chat list quickly.
  // The project's own listing first; the account-wide listing filtered by
  // project_uuid only if that endpoint doesn't answer. See
  // fetchProjectConversations in lib/claude-api.js.
  // Cowork tasks are appended — they live in a separate API and the project's
  // conversation listing never includes them. Their uuid is the cse_ id, which
  // fetchTranscript routes to the sessions API.
  async function listProjectConversations(orgId, projectId) {
    const [convos, cowork] = await Promise.all([
      listProjectChats(orgId, projectId),
      api().fetchProjectCoworkSessions(orgId, projectId).catch((err) => {
        console.warn("[Claude DL] Could not list Cowork tasks:", err);
        return [];
      }),
    ]);
    if (cowork.length) console.info(`[Claude DL] ${cowork.length} Cowork tasks in project ${projectId}.`);
    return [...convos, ...cowork];
  }

  async function listProjectChats(orgId, projectId) {
    const direct = await api().fetchProjectConversations(orgId, projectId);
    if (direct) {
      console.info(`[Claude DL] ${direct.length} conversations in project ${projectId} (project listing).`);
      return direct;
    }
    const list = await fetchConversationList(orgId);
    const convos = filterProjectConversations(list, projectId);
    console.info(
      `[Claude DL] ${convos.length}/${list.length} conversations match project ${projectId} (account listing). ` +
        `${list.filter((c) => c && c.project_uuid).length} of the list carry a project_uuid.`
    );
    return convos;
  }

  async function handleChatsListRequest() {
    const { orgId, projectId } = await resolveOrgProject();
    const convos = await listProjectConversations(orgId, projectId);
    const chats = convos.map((c) => ({
      uuid: c.uuid,
      name: c.name || "untitled",
    }));
    return { chats, projectId };
  }

  // Fetch and format a single chat transcript for an individual download.
  async function handleChatOneRequest(uuid, name, format) {
    // The project's verified org when a project is open; the cookie otherwise.
    const onProject = await resolveVerifiedOrgProject(null).catch(() => null);
    const orgId =
      (onProject && onProject.projectId && onProject.orgId) ||
      findOrgIdFromCookie() ||
      findOrgIdFromPerformanceEntries();
    if (!orgId) throw new Error("Could not find your Claude organization. Reload and try again.");
    const ext = format === "json" ? "json" : "md";
    const transcript = await fetchTranscript(orgId, uuid);
    if (!transcript.name) transcript.name = name || "untitled";
    const content =
      ext === "json" ? transcriptToJson(transcript) : transcriptToMarkdown(transcript);
    return {
      filename: sanitizeChatFilename(name || transcript.name || "untitled", uuid, ext),
      content,
      transcript,
      orgId,
    };
  }

  // format is "markdown" | "json". Returns the data-contract object.
  // When includeAttachments is true each chat also carries an `attachments`
  // array of descriptors; the popup resolves and downloads them, mirroring how
  // it already fetches project files.
  async function handleChatsFetchRequest(format, includeAttachments) {
    const { orgId, projectId } = await resolveOrgProject();
    const convos = await listProjectConversations(orgId, projectId);
    const total = convos.length;

    const chats = [];
    const failed = [];
    const ext = format === "json" ? "json" : "md";
    let done = 0;

    emitChatsProgress(0, total);

    // Simple throttled pool: CHAT_FETCH_CONCURRENCY at a time, gap between batches.
    for (let i = 0; i < convos.length; i += CHAT_FETCH_CONCURRENCY) {
      const slice = convos.slice(i, i + CHAT_FETCH_CONCURRENCY);
      await Promise.all(
        slice.map(async (c) => {
          const label = c.name || "untitled";
          try {
            const transcript = await fetchTranscript(orgId, c.uuid);
            // Ensure the title is present for the formatter.
            if (!transcript.name) transcript.name = label;
            const content =
              ext === "json" ? transcriptToJson(transcript) : transcriptToMarkdown(transcript);
            const entry = { filename: sanitizeChatFilename(label, c.uuid, ext), content };
            if (includeAttachments) {
              try {
                entry.attachments = extractChatAttachments(transcript, orgId) || [];
              } catch (attErr) {
                // A malformed transcript must not lose the chat itself.
                console.warn("[Claude DL] attachment scan failed:", label, attErr);
                entry.attachments = [];
              }
            }
            chats.push(entry);
          } catch (err) {
            console.warn("[Claude DL] chat failed:", label, err);
            failed.push(label);
          } finally {
            done += 1;
            emitChatsProgress(done, total);
          }
        })
      );
      if (i + CHAT_FETCH_CONCURRENCY < convos.length) await sleep(CHAT_FETCH_GAP_MS);
    }

    return { chats, projectId, total, failed };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPE_CHATS_FETCH) return;
    (async () => {
      try {
        const format = message.format === "json" ? "json" : "markdown";
        const result = await handleChatsFetchRequest(format, message.includeAttachments === true);
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error while fetching chats.",
        });
      }
    })();
    return true; // keep channel open for async response
  });

  const MESSAGE_TYPE_CHATS_LIST = "CLAUDE_CHATS_LIST";
  const MESSAGE_TYPE_CHAT_ONE = "CLAUDE_CHAT_FETCH_ONE";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPE_CHATS_LIST) return;
    (async () => {
      try {
        const result = await handleChatsListRequest();
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error while listing chats.",
        });
      }
    })();
    return true; // keep channel open for async response
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPE_CHAT_ONE) return;
    (async () => {
      try {
        const format = message.format === "json" ? "json" : "markdown";
        const result = await handleChatOneRequest(message.uuid, message.name, format);
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error while fetching chat.",
        });
      }
    })();
    return true; // keep channel open for async response
  });
})();
