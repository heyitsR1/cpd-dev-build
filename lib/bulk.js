// lib/bulk.js — bulk actions on many chats at once (v1.16).
//
// Delete and move go through the endpoints claude.ai's own Recents page uses
// (read out of its bundle 2026-10-06):
//
//   POST /api/organizations/{org}/chat_conversations/delete_many
//        { conversation_uuids: [...] }               → { deleted: [...] }
//   POST /api/organizations/{org}/chat_conversations/move_many
//        { conversation_uuids: [...], project_uuid } → { moved?, failed?: [...] }
//
// claude.ai sends delete_many 20 at a time, so we do too. A batch that fails
// marks only its own chats failed; the rest carry on, and the caller reports
// exactly which chats were not touched. Nothing is retried on its own: a
// delete is not something to repeat behind the user's back.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CpdBulk = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ORIGIN = "https://claude.ai";
  const BATCH = 20;
  // Free plan: bulk actions on up to five chats at a time.
  const FREE_BULK_LIMIT = 5;

  function bulkAllowed(count, isPro) {
    if (!count) return { ok: false, error: "empty" };
    if (!isPro && count > FREE_BULK_LIMIT) return { ok: false, error: "limit", limit: FREE_BULK_LIMIT };
    return { ok: true };
  }

  function chunks(list, size = BATCH) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /**
   * @param {(url: string, body: object) => Promise<any>} postJson
   * @returns {Promise<{done: string[], failed: string[]}>}
   */
  async function deleteChats(postJson, orgId, uuids, onProgress = () => {}) {
    const done = [];
    const failed = [];
    for (const batch of chunks(uuids)) {
      try {
        const res = await postJson(`${ORIGIN}/api/organizations/${orgId}/chat_conversations/delete_many`, {
          conversation_uuids: batch,
        });
        // Trust only what the server says it deleted.
        const deleted = new Set(res && Array.isArray(res.deleted) ? res.deleted : []);
        for (const u of batch) (deleted.has(u) ? done : failed).push(u);
      } catch {
        failed.push(...batch);
      }
      onProgress(done.length + failed.length, uuids.length);
    }
    return { done, failed };
  }

  async function moveChats(postJson, orgId, uuids, projectUuid, onProgress = () => {}) {
    const done = [];
    const failed = [];
    for (const batch of chunks(uuids)) {
      try {
        const res = await postJson(`${ORIGIN}/api/organizations/${orgId}/chat_conversations/move_many`, {
          conversation_uuids: batch,
          project_uuid: projectUuid,
        });
        const bad = new Set(res && Array.isArray(res.failed) ? res.failed.map((f) => (f && f.uuid) || f) : []);
        for (const u of batch) (bad.has(u) ? failed : done).push(u);
      } catch {
        failed.push(...batch);
      }
      onProgress(done.length + failed.length, uuids.length);
    }
    return { done, failed };
  }

  return { BATCH, FREE_BULK_LIMIT, bulkAllowed, chunks, deleteChats, moveChats };
});
