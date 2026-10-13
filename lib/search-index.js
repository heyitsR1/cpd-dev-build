// lib/search-index.js — full-text search across every chat (v1.16).
//
// claude.ai's own search matches titles. This one reads what was said: each
// transcript is fetched once through the same endpoint the export uses, turned
// into plain text, and kept in the extension's IndexedDB on this computer.
// A sync afterwards fetches only chats whose updated_at moved, so keeping the
// index current costs one listing call plus a fetch per changed chat.
//
// This file is the pure part — what to fetch, how to match, how to score,
// what snippet to show — so it can be tested in Node. Storage lives in
// library/search-store.js.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CpdSearch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Free plan sees the five best matches; the rest are counted, not shown.
  const FREE_RESULT_LIMIT = 5;
  const SNIPPET_RADIUS = 70;

  /** Plain searchable text for a transcript, given chat-format's markdown renderer. */
  function searchText(transcript, toMarkdown) {
    const md = String(toMarkdown(transcript) || "");
    // Drop the "# Title" line (the title is matched separately, and weighted)
    // and the role headings, which would make every chat match "assistant".
    return md
      .replace(/^# .*\n/, "")
      .replace(/^## (Human|Assistant|System)\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * What a sync has to do.
   * @param {{uuid, name, updated_at}[]} listing   every chat claude.ai lists now
   * @param {Object<string, {updated_at}>} stored  meta for chats already indexed
   * @returns {{fetch: object[], drop: string[], fresh: number}}
   *   fetch is newest first, so a sync that is cut short has the chats people
   *   are most likely to look for.
   */
  function planSync(listing, stored) {
    const have = stored || {};
    const live = new Set();
    const fetch = [];
    let fresh = 0;
    for (const c of Array.isArray(listing) ? listing : []) {
      if (!c || !c.uuid || live.has(c.uuid)) continue;
      live.add(c.uuid);
      const prev = have[c.uuid];
      if (prev && prev.updated_at === c.updated_at && !prev.failed) fresh += 1;
      else fetch.push(c);
    }
    fetch.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const drop = Object.keys(have).filter((u) => !live.has(u));
    return { fetch, drop, fresh };
  }

  function fold(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "");
  }

  /** `foo "exact phrase" bar` → ["foo", "exact phrase", "bar"], folded. */
  function parseQuery(q) {
    const terms = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(q || "")))) {
      const t = fold((m[1] || m[2] || "").trim());
      if (t && !terms.includes(t)) terms.push(t);
    }
    return terms;
  }

  function countOf(hay, needle, cap = 50) {
    let n = 0;
    let i = hay.indexOf(needle);
    while (i >= 0 && n < cap) {
      n += 1;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  }

  /**
   * A short window of the original text around the first match, split so the
   * caller can wrap `match` in <mark> without parsing HTML.
   * Folding can change string length for a few scripts; if it did, fall back
   * to the start of the text rather than highlight the wrong characters.
   */
  function snippet(text, folded, term) {
    const src = String(text || "");
    const i = folded.indexOf(term);
    if (i < 0 || folded.length !== src.length) {
      const head = src.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim();
      return { before: head, match: "", after: src.length > SNIPPET_RADIUS * 2 ? "…" : "" };
    }
    const start = Math.max(0, i - SNIPPET_RADIUS);
    const end = Math.min(src.length, i + term.length + SNIPPET_RADIUS);
    const squash = (s) => s.replace(/\s+/g, " ");
    return {
      before: (start > 0 ? "…" : "") + squash(src.slice(start, i)).replace(/^\S*\s/, start > 0 ? "" : "$&"),
      match: src.slice(i, i + term.length),
      after: squash(src.slice(i + term.length, end)) + (end < src.length ? "…" : ""),
    };
  }

  /**
   * Prepare docs once per load; searching then only lowercases the query.
   * @param {{uuid, name, text, updated_at, project_uuid}[]} docs
   */
  function prepare(docs) {
    return (Array.isArray(docs) ? docs : [])
      .filter((d) => d && d.uuid)
      .map((d) => ({ ...d, _name: fold(d.name), _text: fold(d.text) }));
  }

  /**
   * Every chat that contains all the terms (title or body), best first.
   * Title hits outweigh body hits; ties go to the most recent chat.
   * @returns {{uuid, name, updated_at, project_uuid, score, snippet}[]}
   */
  function search(prepared, query) {
    const terms = parseQuery(query);
    if (!terms.length) return [];
    const out = [];
    for (const d of prepared) {
      let score = 0;
      let firstBodyTerm = null;
      let all = true;
      for (const t of terms) {
        const inName = d._name.includes(t);
        const inBody = countOf(d._text, t);
        if (!inName && !inBody) {
          all = false;
          break;
        }
        score += (inName ? 10 : 0) + Math.min(inBody, 20);
        if (inBody && firstBodyTerm == null) firstBodyTerm = t;
      }
      if (!all) continue;
      out.push({
        uuid: d.uuid,
        name: d.name,
        updated_at: d.updated_at,
        project_uuid: d.project_uuid || null,
        score,
        snippet: firstBodyTerm ? snippet(d.text, d._text, firstBodyTerm) : null,
      });
    }
    out.sort((a, b) => b.score - a.score || String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return out;
  }

  /** The free plan's cut: what to show, and how many more there are. */
  function visibleResults(results, isPro) {
    const list = Array.isArray(results) ? results : [];
    if (isPro || list.length <= FREE_RESULT_LIMIT) return { shown: list, locked: 0 };
    return { shown: list.slice(0, FREE_RESULT_LIMIT), locked: list.length - FREE_RESULT_LIMIT };
  }

  return { FREE_RESULT_LIMIT, searchText, planSync, parseQuery, prepare, search, snippet, visibleResults, fold };
});
