// lib/folders.js — folders for chats and projects (v1.16, the toolbox).
//
// One state object in chrome.storage.local under FOLDERS_KEY:
//
//   { v: 1,
//     folders: [{ id, name, createdAt }],                  // display order
//     items:   { "chat:<uuid>": { folderId, kind, uuid, name, addedAt } } }
//
// An item sits in at most one folder, like a file in a directory. The item
// carries its own title so the claude.ai sidebar can draw a folder's contents
// without an API call; the Library refreshes those titles when it lists chats.
//
// Every function here is pure and returns a new state, so the side panel, the
// Library, and the in-page sidebar can all write through the same rules and
// the rules can be tested in Node. Nothing leaves the browser.
//
// Loaded as a page/content-script global (window.CpdFolders) and as a
// CommonJS module for the Node tests.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CpdFolders = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FOLDERS_KEY = "cpdFolders";
  // Free plan: three folders, as many chats in them as you like. Enough to feel
  // the difference in the sidebar; a real library outgrows it.
  const FREE_FOLDER_LIMIT = 3;
  const MAX_NAME = 60;
  const KINDS = new Set(["chat", "project"]);

  function emptyState() {
    return { v: 1, folders: [], items: {} };
  }

  function itemKey(kind, uuid) {
    return `${kind}:${uuid}`;
  }

  function cleanName(name) {
    return String(name == null ? "" : name).replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  }

  /** Whatever storage held, as a valid state. Drops items whose folder is gone. */
  function normalize(raw) {
    const out = emptyState();
    if (!raw || typeof raw !== "object") return out;
    const seen = new Set();
    for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
      if (!f || typeof f.id !== "string" || seen.has(f.id)) continue;
      const name = cleanName(f.name);
      if (!name) continue;
      seen.add(f.id);
      out.folders.push({ id: f.id, name, createdAt: Number(f.createdAt) || 0 });
    }
    const items = raw.items && typeof raw.items === "object" ? raw.items : {};
    for (const [key, it] of Object.entries(items)) {
      if (!it || !seen.has(it.folderId) || !KINDS.has(it.kind) || typeof it.uuid !== "string") continue;
      if (key !== itemKey(it.kind, it.uuid)) continue;
      out.items[key] = {
        folderId: it.folderId,
        kind: it.kind,
        uuid: it.uuid,
        name: String(it.name || ""),
        addedAt: Number(it.addedAt) || 0,
      };
    }
    return out;
  }

  function newId(now) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `f${Number(now).toString(36)}${rand}`;
  }

  function canCreateFolder(state, isPro) {
    return !!isPro || normalize(state).folders.length < FREE_FOLDER_LIMIT;
  }

  /**
   * @returns {{ok: true, state, folder} | {ok: false, error: "empty_name"|"duplicate"|"limit"}}
   */
  function createFolder(state, name, { isPro = false, now = Date.now(), id } = {}) {
    const s = normalize(state);
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: "empty_name" };
    if (s.folders.some((f) => f.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: "duplicate" };
    if (!canCreateFolder(s, isPro)) return { ok: false, error: "limit" };
    const folder = { id: id || newId(now), name: clean, createdAt: now };
    return { ok: true, state: { ...s, folders: [...s.folders, folder] }, folder };
  }

  function renameFolder(state, folderId, name) {
    const s = normalize(state);
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: "empty_name" };
    if (!s.folders.some((f) => f.id === folderId)) return { ok: false, error: "not_found" };
    if (s.folders.some((f) => f.id !== folderId && f.name.toLowerCase() === clean.toLowerCase())) {
      return { ok: false, error: "duplicate" };
    }
    return { ok: true, state: { ...s, folders: s.folders.map((f) => (f.id === folderId ? { ...f, name: clean } : f)) } };
  }

  /** Deleting a folder never deletes chats: its items simply become unfiled. */
  function deleteFolder(state, folderId) {
    const s = normalize(state);
    const items = {};
    for (const [k, it] of Object.entries(s.items)) if (it.folderId !== folderId) items[k] = it;
    return { ...s, folders: s.folders.filter((f) => f.id !== folderId), items };
  }

  /**
   * File items into a folder, or unfile them with folderId = null.
   * @param {{kind: "chat"|"project", uuid: string, name?: string}[]} list
   */
  function assign(state, list, folderId, { now = Date.now() } = {}) {
    const s = normalize(state);
    if (folderId != null && !s.folders.some((f) => f.id === folderId)) return s;
    const items = { ...s.items };
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || !KINDS.has(it.kind) || typeof it.uuid !== "string" || !it.uuid) continue;
      const key = itemKey(it.kind, it.uuid);
      if (folderId == null) {
        delete items[key];
        continue;
      }
      const prev = items[key];
      items[key] = {
        folderId,
        kind: it.kind,
        uuid: it.uuid,
        name: String(it.name || (prev && prev.name) || ""),
        addedAt: prev && prev.folderId === folderId ? prev.addedAt : now,
      };
    }
    return { ...s, items };
  }

  /** Forget items that no longer exist on claude.ai (deleted elsewhere). */
  function forget(state, kind, uuids) {
    const s = normalize(state);
    const items = { ...s.items };
    for (const u of uuids || []) delete items[itemKey(kind, u)];
    return { ...s, items };
  }

  /** Keep stored titles in step with claude.ai after a rename there. */
  function refreshNames(state, kind, rows) {
    const s = normalize(state);
    let changed = false;
    const items = { ...s.items };
    for (const r of rows || []) {
      if (!r || !r.uuid) continue;
      const key = itemKey(kind, r.uuid);
      const it = items[key];
      const name = String(r.name || "");
      if (it && name && it.name !== name) {
        items[key] = { ...it, name };
        changed = true;
      }
    }
    return changed ? { ...s, items } : s;
  }

  function folderOf(state, kind, uuid) {
    const it = normalize(state).items[itemKey(kind, uuid)];
    return it ? it.folderId : null;
  }

  /** A folder's items, newest-filed first. */
  function itemsIn(state, folderId) {
    return Object.values(normalize(state).items)
      .filter((it) => it.folderId === folderId)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  function counts(state) {
    const s = normalize(state);
    const out = {};
    for (const f of s.folders) out[f.id] = 0;
    for (const it of Object.values(s.items)) out[it.folderId] += 1;
    return out;
  }

  return {
    FOLDERS_KEY,
    FREE_FOLDER_LIMIT,
    emptyState,
    normalize,
    itemKey,
    canCreateFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    assign,
    forget,
    refreshNames,
    folderOf,
    itemsIn,
    counts,
  };
});
