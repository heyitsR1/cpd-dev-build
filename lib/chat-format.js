// Pure helpers for exporting Claude project chats.
// Loaded both as a content-script global and as a CommonJS module (Node tests).
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node / tests
  } else {
    // Content-script isolated world: expose as globals for content.js
    root.sanitizeChatFilename = api.sanitizeChatFilename;
    root.filterProjectConversations = api.filterProjectConversations;
    root.transcriptToMarkdown = api.transcriptToMarkdown;
    root.transcriptToJson = api.transcriptToJson;
    root.extractChatAttachments = api.extractChatAttachments;
    root.uniquifyAttachmentName = api.uniquifyAttachmentName;
    root.base64ToUint8Array = api.base64ToUint8Array;
    // For print/print.js (PDF): the same per-message text the Markdown uses.
    root.CpdChatFormat = { messageText: api.messageText, roleLabel: api.roleLabel, attachmentNames: api.attachmentNames };
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function sanitizeChatFilename(name, uuid, ext) {
    const base = String(name || "").trim();
    // Drop characters illegal in file names across OSes.
    const cleaned = base.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
    const safe = cleaned || "untitled";
    const shortUuid = String(uuid || "").split("-")[0] || "id";
    return `${safe}--${shortUuid}.${ext}`;
  }

  function filterProjectConversations(list, projectId) {
    if (!Array.isArray(list)) return [];
    return list.filter((c) => c && c.project_uuid === projectId);
  }

  // Claude's API substitutes this exact sentence for any block the requesting
  // client didn't opt into. We now ask for render_all_tools=true, but old
  // transcripts and any block type we still don't understand can carry it, and
  // it must never reach the exported file.
  const UNSUPPORTED_BLOCK_RE = /This block is not supported on your current device yet\./i;

  function stripPlaceholders(text) {
    if (typeof text !== "string") return "";
    if (!UNSUPPORTED_BLOCK_RE.test(text)) return text; // leave clean text byte-identical
    return text
      .replace(/```\s*This block is not supported on your current device yet\.\s*```/gi, "")
      .replace(/This block is not supported on your current device yet\./gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function baseName(p) {
    const parts = String(p || "").trim().split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p || "").trim();
  }

  /**
   * URL for a file living in a conversation's sandbox — both the user's uploads
   * and anything Claude wrote.
   *
   * Claude keys these by conversation + absolute path, NOT by file uuid. Every
   * /files/<uuid>/... shape returns 404 for them, which is what made these look
   * unretrievable; this is the URL Claude's own artifact Download button uses.
   * Only /mnt/user-data/... is served — Claude's scratch dir (/home/claude/work)
   * is not, so a create_file script there still has to come from its inline body.
   */
  function wiggleDownloadUrl(orgId, convUuid, sandboxPath) {
    if (!orgId || !convUuid || !sandboxPath) return null;
    if (!String(sandboxPath).startsWith("/mnt/user-data/")) return null;
    return (
      `https://claude.ai/api/organizations/${orgId}/conversations/${convUuid}` +
      `/wiggle/download-file?path=${encodeURIComponent(sandboxPath)}`
    );
  }

  // Files-API URLs for an upload or a delivered file, best first. `/contents`
  // (plural) is what Claude's own UI requests, and the only one that serves
  // files a session delivered with SendUserFile. `/content` 404'd on every file
  // checked on 2026-09-27; the rest are kept as last resorts.
  function filesApiUrls(orgId, fileId) {
    if (!orgId || !fileId) return [];
    return [
      `https://claude.ai/api/organizations/${orgId}/files/${fileId}/contents`,
      `https://claude.ai/api/organizations/${orgId}/files/${fileId}/content`,
      `https://claude.ai/api/${orgId}/files/${fileId}/content`,
      `https://claude.ai/api/organizations/${orgId}/files/${fileId}`,
    ];
  }

  const FENCE_LANGS = {
    js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript",
    jsx: "jsx", tsx: "tsx", py: "python", json: "json", css: "css", scss: "scss",
    html: "html", md: "markdown", yaml: "yaml", yml: "yaml", sh: "bash",
    bash: "bash", sql: "sql", rs: "rust", go: "go", c: "c", cpp: "cpp",
    java: "java", php: "php", rb: "ruby", xml: "xml", svg: "xml",
  };

  function fenceLanguageFor(fileName) {
    const m = String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return (m && FENCE_LANGS[m[1]]) || "";
  }

  // Render one content block. Tool blocks used to contribute nothing at all, so
  // an assistant turn whose whole output was an artifact exported as an empty
  // "## Assistant" heading — the "some artifacts don't download" report.
  function blockToMarkdown(block) {
    if (!block || typeof block !== "object") return "";

    if (block.type === "text") return stripPlaceholders(block.text);

    if (block.type === "tool_use") {
      const name = block.name || "tool";
      const input = block.input && typeof block.input === "object" ? block.input : {};
      if (name === "create_file" && typeof input.file_text === "string") {
        const file = baseName(input.path) || "file";
        return `**Claude created \`${file}\`**\n\n\`\`\`${fenceLanguageFor(file)}\n${input.file_text}\n\`\`\``;
      }
      // The agent tools used by sessions from the unified Chat/Cowork box.
      if (name === "Write" && typeof input.content === "string") {
        const file = baseName(input.file_path) || "file";
        return `**Claude created \`${file}\`**\n\n\`\`\`${fenceLanguageFor(file)}\n${input.content}\n\`\`\``;
      }
      if (name === "present_files" || name === "SendUserFile") {
        const list = Array.isArray(input.filepaths) ? input.filepaths : input.files;
        const paths = Array.isArray(list) ? list.map(baseName).filter(Boolean) : [];
        return paths.length ? `**Claude shared: ${paths.join(", ")}**` : "";
      }
      return `_[Claude used ${name}]_`;
    }

    // Only surface tool results that name a produced artifact. Search and shell
    // results are large and already summarized in the assistant's prose.
    if (block.type === "tool_result") {
      const items = Array.isArray(block.content) ? block.content : [];
      const names = items
        .filter((i) => i && i.type === "local_resource")
        .map((i) => i.name || baseName(i.file_path))
        .filter(Boolean);
      return names.length ? `_[Artifact: ${names.join(", ")}]_` : "";
    }

    return "";
  }

  function messageText(msg) {
    if (!msg || typeof msg !== "object") return "";
    // Content blocks first: under rendering_mode=messages `text` is empty and the
    // real message (including tool and artifact blocks) lives in `content`.
    if (Array.isArray(msg.content) && msg.content.length) {
      const rendered = msg.content
        .map(blockToMarkdown)
        .filter((s) => s && s.trim())
        .join("\n\n");
      if (rendered.trim()) return rendered;
    }
    return stripPlaceholders(msg.text);
  }

  // Names of everything uploaded with a message (deduplicated).
  function attachmentNames(msg) {
    if (!msg || typeof msg !== "object") return [];
    const names = [];
    const collect = (list) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const name = item.file_name || item.name;
        if (name) names.push(name);
      }
    };
    // An upload lands in any of these three depending on how it was added.
    // Reading only `attachments` meant a whole class of upload — everything the
    // API returns under `files` — exported with no marker at all.
    collect(msg.attachments);
    collect(msg.files);
    collect(msg.files_v2);
    return [...new Set(names)];
  }

  function attachmentNotes(msg) {
    return attachmentNames(msg).map((n) => `\n\n[attachment: ${n}]`).join("");
  }

  function transcriptToMarkdown(transcript) {
    const title = (transcript && transcript.name) || "Untitled chat";
    const messages =
      transcript && Array.isArray(transcript.chat_messages) ? transcript.chat_messages : [];
    const lines = [`# ${title}`, ""];
    for (const msg of messages) {
      lines.push(`## ${roleLabel(msg)}`, "", messageText(msg) + attachmentNotes(msg), "");
    }
    return lines.join("\n");
  }

  function roleLabel(msg) {
    const sender = msg && typeof msg.sender === "string" ? msg.sender : "";
    if (sender === "assistant") return "Assistant";
    if (sender === "human") return "Human";
    // Preserve any other role (e.g. "system") with a capitalized label.
    return sender ? sender.charAt(0).toUpperCase() + sender.slice(1) : "Human";
  }

  function transcriptToJson(transcript) {
    return JSON.stringify(transcript, null, 2);
  }

  function extensionFromMediaType(mediaType) {
    if (!mediaType) return ".bin";
    const mt = String(mediaType).toLowerCase();
    if (mt.includes("png")) return ".png";
    if (mt.includes("jpeg") || mt.includes("jpg")) return ".jpg";
    if (mt.includes("webp")) return ".webp";
    if (mt.includes("gif")) return ".gif";
    if (mt.includes("svg")) return ".svg";
    if (mt.includes("pdf")) return ".pdf";
    if (mt.includes("json")) return ".json";
    if (mt.includes("csv")) return ".csv";
    if (mt.includes("html")) return ".html";
    if (mt.includes("plain") || mt.includes("text")) return ".txt";
    return ".bin";
  }

  function sanitizeAttachmentFilename(name, fallback = "attachment") {
    const base = String(name || "").trim();
    const cleaned = base.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
    return cleaned || fallback;
  }

  function uniquifyAttachmentName(usedNamesSet, originalName, fallback = "attachment") {
    const safeName = sanitizeAttachmentFilename(originalName, fallback);
    if (!usedNamesSet.has(safeName)) {
      usedNamesSet.add(safeName);
      return safeName;
    }

    const lastDot = safeName.lastIndexOf(".");
    const stem = lastDot > 0 ? safeName.slice(0, lastDot) : safeName;
    const ext = lastDot > 0 ? safeName.slice(lastDot) : "";

    let counter = 2;
    while (usedNamesSet.has(`${stem}-${counter}${ext}`)) {
      counter++;
    }

    const uniqueName = `${stem}-${counter}${ext}`;
    usedNamesSet.add(uniqueName);
    return uniqueName;
  }

  function base64ToUint8Array(base64Str) {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(base64Str, "base64"));
    }
    const binary = atob(base64Str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function getExtensionForArtifact(language, type, content) {
    const lang = String(language || "").toLowerCase().trim();
    if (lang) {
      switch (lang) {
        case "html": return ".html";
        case "javascript": case "js": return ".js";
        case "typescript": case "ts": return ".ts";
        case "jsx": return ".jsx";
        case "tsx": return ".tsx";
        case "python": case "py": return ".py";
        case "json": return ".json";
        case "css": return ".css";
        case "scss": return ".scss";
        case "svg": return ".svg";
        case "markdown": case "md": return ".md";
        case "yaml": case "yml": return ".yaml";
        case "sh": case "bash": case "shell": case "zsh": return ".sh";
        case "sql": return ".sql";
        case "rust": case "rs": return ".rs";
        case "go": case "golang": return ".go";
        case "c": return ".c";
        case "cpp": case "c++": return ".cpp";
        case "java": return ".java";
        case "php": return ".php";
        case "ruby": case "rb": return ".rb";
        case "mermaid": return ".mmd";
        case "xml": return ".xml";
        case "dockerfile": return "";
      }
    }

    const t = String(type || "").toLowerCase().trim();
    if (t) {
      if (t.includes("html")) return ".html";
      if (t.includes("svg")) return ".svg";
      if (t.includes("markdown")) return ".md";
      if (t.includes("react") || t.includes("jsx")) return ".jsx";
      if (t.includes("mermaid")) return ".mmd";
      if (t.includes("json")) return ".json";
      if (t.includes("css")) return ".css";
      if (t.includes("javascript")) return ".js";
    }

    const str = String(content || "").trim();
    if (str.startsWith("<!DOCTYPE html") || str.startsWith("<html")) return ".html";
    if (str.startsWith("<svg") || str.includes("xmlns=\"http://www.w3.org/2000/svg\"")) return ".svg";
    if (str.startsWith("{") && str.endsWith("}")) {
      try { JSON.parse(str); return ".json"; } catch {}
    }

    return ".txt";
  }

  function extractArtifactsFromText(text, usedNames) {
    const artifacts = [];
    if (typeof text !== "string" || !text.includes("<antArtifact")) return artifacts;

    const regex = /<antArtifact\s+([^>]*?)>([\s\S]*?)<\/antArtifact>/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const attrString = match[1] || "";
      const rawContent = match[2] || "";

      const titleMatch = attrString.match(/title="([^"]*)"/i) || attrString.match(/title='([^']*)'/i);
      const langMatch = attrString.match(/language="([^"]*)"/i) || attrString.match(/language='([^']*)'/i);
      const typeMatch = attrString.match(/type="([^"]*)"/i) || attrString.match(/type='([^']*)'/i);
      const idMatch = attrString.match(/identifier="([^"]*)"/i) || attrString.match(/identifier='([^']*)'/i);

      const title = titleMatch ? titleMatch[1] : (idMatch ? idMatch[1] : "artifact");
      const language = langMatch ? langMatch[1] : "";
      const type = typeMatch ? typeMatch[1] : "";

      const ext = getExtensionForArtifact(language, type, rawContent);
      let fileName = sanitizeAttachmentFilename(title, "artifact");
      if (ext && !fileName.toLowerCase().endsWith(ext.toLowerCase())) {
        fileName = `${fileName}${ext}`;
      }

      const uniqueName = uniquifyAttachmentName(usedNames, fileName, `artifact${ext || ".txt"}`);
      artifacts.push({
        name: uniqueName,
        type: "text",
        content: rawContent.trim(),
        mediaType: type || "text/plain",
      });
    }

    return artifacts;
  }

  /**
   * Extract all downloadable attachments, inline media, and Claude-generated artifacts from a chat transcript.
   * @param {object} transcript Full transcript object from Claude API
   * @param {string|null} orgId Organization UUID for resolving file URLs
   * @returns {Array<{name:string, type:"url"|"base64"|"text", url?:string, candidateUrls?:string[], data?:string, content?:string, mediaType?:string, fallbackText?:string}>}
   */
  function extractChatAttachments(transcript, orgId) {
    const attachments = [];
    const usedNames = new Set();
    // Basenames already saved verbatim from a create_file call. present_files
    // re-announces those same files, and a "we couldn't fetch this" stub for a
    // file sitting right there in attachments/ sends the user on a pointless
    // manual download.
    const capturedFiles = new Set();
    // Sandbox downloads are scoped to the conversation, so every such URL needs
    // this. It ships on the transcript itself.
    const convUuid = (transcript && transcript.uuid) || null;
    const messages = (transcript && Array.isArray(transcript.chat_messages)) ? transcript.chat_messages : [];

    let imageCounter = 1;
    let docCounter = 1;

    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;

      // 1. Check msg.attachments (user uploaded files)
      const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
      for (const att of atts) {
        if (!att || typeof att !== "object") continue;
        const rawName = att.file_name || att.name || `attachment_${docCounter}`;
        const name = uniquifyAttachmentName(usedNames, rawName, `attachment_${docCounter}`);
        const fallbackText = att.extracted_content || att.content || null;

        // Collect all possible candidate URLs for downloading
        const candidateUrls = [];
        if (att.preview_asset && att.preview_asset.url) candidateUrls.push(att.preview_asset.url);
        if (att.document_asset && att.document_asset.url) candidateUrls.push(att.document_asset.url);
        if (att.download_url) candidateUrls.push(att.download_url);
        if (att.url) candidateUrls.push(att.url);
        if (att.preview_url) candidateUrls.push(att.preview_url);
        if (att.thumbnail_url) candidateUrls.push(att.thumbnail_url);
        if (att.image_url) candidateUrls.push(att.image_url);

        // Try the sandbox path first — it is what Claude's own UI downloads.
        const attWiggle = wiggleDownloadUrl(orgId, convUuid, att.path);
        if (attWiggle) candidateUrls.unshift(attWiggle);

        candidateUrls.push(...filesApiUrls(orgId, att.file_uuid || att.uuid || att.id));

        if (candidateUrls.length > 0) {
          attachments.push({
            name,
            type: "url",
            url: candidateUrls[0],
            candidateUrls,
            fallbackText: typeof fallbackText === "string" ? fallbackText : undefined,
          });
        } else if (typeof fallbackText === "string" && fallbackText.trim()) {
          attachments.push({
            name: name.endsWith(".txt") ? name : `${name}.txt`,
            type: "text",
            content: fallbackText,
          });
        }
        docCounter++;
      }

      // 2. Check msg.files / msg.files_v2 — newer uploads land in files_v2, and
      // reading only `files` missed them entirely.
      const files = [
        ...(Array.isArray(msg.files) ? msg.files : []),
        ...(Array.isArray(msg.files_v2) ? msg.files_v2 : []),
      ];
      for (const file of files) {
        if (!file || typeof file !== "object") continue;
        const rawName = file.file_name || file.name || `file_${docCounter}`;
        const name = uniquifyAttachmentName(usedNames, rawName, `file_${docCounter}`);
        const fallbackText = file.extracted_content || file.content || null;

        const candidateUrls = [];
        if (file.preview_asset && file.preview_asset.url) candidateUrls.push(file.preview_asset.url);
        if (file.document_asset && file.document_asset.url) candidateUrls.push(file.document_asset.url);
        if (file.download_url) candidateUrls.push(file.download_url);
        if (file.url) candidateUrls.push(file.url);
        if (file.preview_url) candidateUrls.push(file.preview_url);

        // The upload's sandbox path. This is the only thing that works for
        // file_kind "blob", which carries no asset URLs whatsoever — those
        // uploads exported as "HTTP 404" until we started using this.
        // A file a session delivered (download_source "files-api") is the
        // reverse: its sandbox path 404s and only /contents serves it.
        const fileWiggle = wiggleDownloadUrl(orgId, convUuid, file.path);
        const apiUrls = filesApiUrls(orgId, file.file_uuid || file.uuid || file.id);
        if (file.download_source === "files-api") {
          candidateUrls.unshift(...apiUrls);
          if (fileWiggle) candidateUrls.push(fileWiggle);
        } else {
          if (fileWiggle) candidateUrls.unshift(fileWiggle);
          candidateUrls.push(...apiUrls);
        }

        if (candidateUrls.length > 0) {
          attachments.push({
            name,
            type: "url",
            url: candidateUrls[0],
            candidateUrls,
            fallbackText: typeof fallbackText === "string" ? fallbackText : undefined,
          });
        } else if (typeof fallbackText === "string" && fallbackText.trim()) {
          attachments.push({
            name: name.endsWith(".txt") ? name : `${name}.txt`,
            type: "text",
            content: fallbackText,
          });
        }
        docCounter++;
      }

      // 3. Check msg.content blocks (images, documents, artifacts, tool_uses)
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;

          if (block.type === "image" && block.source) {
            const mediaType = block.source.media_type || "image/png";
            const ext = extensionFromMediaType(mediaType);
            const rawName = block.title || block.name || `image_${imageCounter}${ext}`;
            const name = uniquifyAttachmentName(usedNames, rawName, `image_${imageCounter}${ext}`);

            if (block.source.type === "base64" && block.source.data) {
              attachments.push({
                name,
                type: "base64",
                data: block.source.data,
                mediaType,
              });
              imageCounter++;
            } else if (block.source.type === "url" && block.source.url) {
              attachments.push({
                name,
                type: "url",
                url: block.source.url,
                candidateUrls: [block.source.url],
                mediaType,
              });
              imageCounter++;
            }
          } else if (block.type === "document" && block.source) {
            const mediaType = block.source.media_type || "application/pdf";
            const ext = extensionFromMediaType(mediaType);
            const rawName = block.title || block.name || `document_${docCounter}${ext}`;
            const name = uniquifyAttachmentName(usedNames, rawName, `document_${docCounter}${ext}`);

            if (block.source.type === "base64" && block.source.data) {
              attachments.push({
                name,
                type: "base64",
                data: block.source.data,
                mediaType,
              });
              docCounter++;
            } else if (block.source.type === "url" && block.source.url) {
              attachments.push({
                name,
                type: "url",
                url: block.source.url,
                candidateUrls: [block.source.url],
                mediaType,
              });
              docCounter++;
            }
          } else if (block.type === "artifact" || block.type === "code") {
            const title = block.title || block.identifier || block.name || "artifact";
            const language = (block.language || "").toLowerCase();
            const type = (block.type || "").toLowerCase();
            const content = block.text || block.content || "";
            const ext = getExtensionForArtifact(language, type, content);
            let fileName = sanitizeAttachmentFilename(title, "artifact");
            if (ext && !fileName.toLowerCase().endsWith(ext.toLowerCase())) {
              fileName = `${fileName}${ext}`;
            }
            const uniqueName = uniquifyAttachmentName(usedNames, fileName, `artifact${ext || ".txt"}`);
            attachments.push({
              name: uniqueName,
              type: "text",
              content: content.trim(),
              mediaType: type || "text/plain",
            });
          } else if (block.type === "tool_use" && (block.name === "artifacts" || block.name === "create_artifact") && block.input) {
            const input = block.input;
            const title = input.title || input.identifier || "artifact";
            const language = (input.language || "").toLowerCase();
            const type = (input.type || "").toLowerCase();
            const content = input.content || "";
            const ext = getExtensionForArtifact(language, type, content);
            let fileName = sanitizeAttachmentFilename(title, "artifact");
            if (ext && !fileName.toLowerCase().endsWith(ext.toLowerCase())) {
              fileName = `${fileName}${ext}`;
            }
            const uniqueName = uniquifyAttachmentName(usedNames, fileName, `artifact${ext || ".txt"}`);
            attachments.push({
              name: uniqueName,
              type: "text",
              content: content.trim(),
              mediaType: type || "text/plain",
            });
          } else if (
            block.type === "tool_use" &&
            block.name === "create_file" &&
            block.input &&
            typeof block.input.file_text === "string"
          ) {
            // Claude's current file-creation tool. The body is inline, so this
            // needs no network fetch. The legacy `artifacts` tool name above has
            // not been emitted by Claude for a long time.
            const sourceName = baseName(block.input.path);
            if (sourceName) capturedFiles.add(sourceName);
            const rawName = sanitizeAttachmentFilename(sourceName || "file", "file");
            const name = uniquifyAttachmentName(usedNames, rawName, "file.txt");
            attachments.push({ name, type: "text", content: block.input.file_text });
          } else if (
            block.type === "tool_result" &&
            block.name === "present_files" &&
            Array.isArray(block.content)
          ) {
            // The user-facing generated artifact (e.g. a .docx Claude built).
            // Fetched from the conversation sandbox by path — the same URL the
            // web app's own Download button uses. The note survives only as a
            // fallback for the case where that fetch fails.
            for (const item of block.content) {
              if (!item || item.type !== "local_resource") continue;
              // Saved in full by the create_file branch above; no fetch needed.
              const producedFile = baseName(item.file_path);
              if (producedFile && capturedFiles.has(producedFile)) continue;
              const label = item.name || producedFile || "artifact";
              const note =
                `Claude generated this artifact in the chat:\n\n` +
                `  Name: ${label}\n` +
                `  File: ${producedFile || "(unknown)"}\n` +
                `  Type: ${item.mime_type || "(unknown)"}\n\n` +
                `Its contents could not be downloaded. Open the chat and use the\n` +
                `Download button on the artifact to save it.\n`;
              const url = wiggleDownloadUrl(orgId, convUuid, item.file_path);
              if (url) {
                const fileName = uniquifyAttachmentName(
                  usedNames,
                  sanitizeAttachmentFilename(producedFile || label, "artifact"),
                  "artifact"
                );
                attachments.push({
                  name: fileName,
                  type: "url",
                  url,
                  candidateUrls: [url],
                  fallbackText: note,
                });
              } else {
                const noteName = uniquifyAttachmentName(
                  usedNames,
                  sanitizeAttachmentFilename(`${label}.txt`, "artifact.txt"),
                  "artifact.txt"
                );
                attachments.push({ name: `_artifacts/${noteName}`, type: "text", content: note });
              }
            }
          } else if (block.type === "text" && typeof block.text === "string") {
            const textArtifacts = extractArtifactsFromText(block.text, usedNames);
            attachments.push(...textArtifacts);
          }
        }
      }

      // 4. Check msg.text for Claude artifacts (<antArtifact> tags)
      if (typeof msg.text === "string") {
        const textArtifacts = extractArtifactsFromText(msg.text, usedNames);
        attachments.push(...textArtifacts);
      }
    }

    return attachments;
  }

  return {
    sanitizeChatFilename,
    filterProjectConversations,
    transcriptToMarkdown,
    transcriptToJson,
    extensionFromMediaType,
    sanitizeAttachmentFilename,
    uniquifyAttachmentName,
    base64ToUint8Array,
    getExtensionForArtifact,
    extractArtifactsFromText,
    extractChatAttachments,
    messageText,
    roleLabel,
    attachmentNames,
  };
});
