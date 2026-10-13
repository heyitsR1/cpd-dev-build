// lib/chat-print.js — chats as a print-ready HTML document, for "Save as PDF"
// (v1.17). print/print.js feeds it transcripts and lets Chrome's own print
// engine make the PDF: selectable text, every script (CJK, Arabic, emoji)
// rendered by the system fonts, small files, no PDF library in the bundle.
//
// Everything that comes out of a chat is untrusted. markdownToHtml escapes the
// source first and only ever emits its own tags; links are kept only for
// http(s) and mailto. Pure functions, loaded as a page global and in Node tests.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CpdChatPrint = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function safeHref(url) {
    const u = String(url || "").trim().replace(/&amp;/g, "&");
    return /^(https?:\/\/|mailto:)/i.test(u) ? esc(u) : null;
  }

  // Inline markup on an already-escaped line. Code spans are cut out first so
  // nothing inside them is formatted.
  function inline(escaped) {
    const codes = [];
    let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text, url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}">${text}</a>` : text;
    });
    // Bare URLs not already inside a link we just made.
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => {
      const href = safeHref(url);
      return href ? `${pre}<a href="${href}">${url}</a>` : m;
    });
    s = s
      // Bold may wrap single-star italics: **actually *notice*.**
      .replace(/\*\*((?:[^*\n]|\*[^*\n]+\*)+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const isTableSep = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("-");
  const cells = (line) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(esc(c.trim())));

  function markdownToHtml(md) {
    const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    const listItemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        const close = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
        i += 1;
        const lang = fence[2] ? `<span class="code-lang">${esc(fence[2])}</span>` : "";
        out.push(`<pre class="code">${lang}<code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }

      if (!line.trim()) { i += 1; continue; }

      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        // Chat headings sit under the message's own heading: shift them down.
        const level = Math.min(6, h[1].length + 2);
        out.push(`<h${level}>${inline(esc(h[2]))}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i += 1; continue; }

      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
            `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        );
        continue;
      }

      if (listItemRe.test(line)) {
        out.push(renderList());
        continue;
      }

      // Paragraph: until a blank line or the start of another block.
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) &&
        !listItemRe.test(lines[i]) &&
        !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
      ) {
        para.push(inline(esc(lines[i])));
        i += 1;
      }
      out.push(`<p>${para.join("<br>")}</p>`);
    }
    return out.join("\n");

    // Nested lists by indentation. Continuation lines join their item.
    function renderList() {
      const baseIndent = lines[i].match(listItemRe)[1].length;
      const ordered = /\d/.test(lines[i].match(listItemRe)[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(listItemRe);
        if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
          items.push({ text: [m[3]], children: [] });
          i += 1;
        } else if (m && m[1].length > baseIndent && items.length) {
          items[items.length - 1].children.push(renderList());
        } else if (lines[i].trim() && !m && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].text.push(lines[i].trim());
          i += 1;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      return `<${tag}>${items
        .map((it) => `<li>${it.text.map((t) => inline(esc(t))).join("<br>")}${it.children.join("")}</li>`)
        .join("")}</${tag}>`;
    }
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  /**
   * One chat as an <article>. `format` is chat-format.js (messageText,
   * roleLabel, attachmentNames), injected so this file stays standalone.
   */
  function transcriptToArticle(transcript, format, { index } = {}) {
    const title = (transcript && transcript.name) || "Untitled chat";
    const messages = Array.isArray(transcript && transcript.chat_messages) ? transcript.chat_messages : [];
    const when = fmtDate(transcript && (transcript.created_at || (messages[0] && messages[0].created_at)));
    const body = messages
      .map((msg) => {
        const role = format.roleLabel(msg);
        const files = format.attachmentNames(msg);
        const text = format.messageText(msg);
        if (!text.trim() && !files.length) return "";
        const roleClass = msg && msg.sender === "assistant" ? "assistant" : "human";
        return `<section class="msg msg--${roleClass}">
<div class="msg__role">${esc(role === "Assistant" ? "Claude" : role === "Human" ? "You" : role)}${msg.created_at ? ` <span class="msg__time">${esc(fmtDate(msg.created_at))}</span>` : ""}</div>
<div class="msg__body">${markdownToHtml(text)}</div>
${files.length ? `<div class="msg__files">Attached: ${files.map(esc).join(", ")}</div>` : ""}
</section>`;
      })
      .filter(Boolean)
      .join("\n");
    const id = index === undefined ? "chat" : `chat-${index}`;
    return `<article class="chat" id="${id}">
<header class="chat__head"><h1>${esc(title)}</h1>${when ? `<p class="chat__meta">${esc(when)} · ${messages.length} message${messages.length === 1 ? "" : "s"}</p>` : ""}</header>
${body || '<p class="empty">This chat has no messages.</p>'}
</article>`;
  }

  /** Several chats: a cover with a linked table of contents, one chat per page run. */
  function transcriptsToDocument(transcripts, format, { title } = {}) {
    if (transcripts.length === 1) return transcriptToArticle(transcripts[0], format);
    const toc = transcripts
      .map((t, i) => `<li><a href="#chat-${i}">${esc(t.name || "Untitled chat")}</a></li>`)
      .join("");
    return `<section class="cover"><h1>${esc(title || "Claude chats")}</h1>
<p class="chat__meta">${transcripts.length} chats · exported ${esc(fmtDate(new Date().toISOString()))}</p>
<ol class="toc">${toc}</ol></section>
${transcripts.map((t, i) => transcriptToArticle(t, format, { index: i })).join("\n")}`;
  }

  return { markdownToHtml, transcriptToArticle, transcriptsToDocument, escapeHtml: esc };
});
