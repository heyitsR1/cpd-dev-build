// search-store.js — the full-text index, in the extension's own IndexedDB.
//
// One database per Claude organisation, so switching accounts never mixes two
// accounts' chats in one result list. Each record is one chat:
//   { uuid, name, updated_at, project_uuid, text, failed? }
// `failed` marks a chat whose transcript could not be fetched; the next sync
// tries it again (see planSync in lib/search-index.js).
//
// It never leaves this computer, and uninstalling the extension deletes it.

const STORE = "chats";

function open(orgId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`cpd-search-${orgId}`, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "uuid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function openIndex(orgId) {
  const db = await open(orgId);
  return {
    /** Every indexed chat, texts included. */
    async all() {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      await done(tx);
      return req.result || [];
    },
    async put(records) {
      if (!records.length) return;
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const r of records) store.put(r);
      await done(tx);
    },
    async remove(uuids) {
      if (!uuids.length) return;
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const u of uuids) store.delete(u);
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}
