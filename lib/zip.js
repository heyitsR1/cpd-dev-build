/*!
 * Tiny ZIP utility (store-only, no compression) for browser extensions.
 * - Supports UTF-8 filenames and file content
 * - Works entirely in-browser without external dependencies
 * - Produces a valid ZIP Blob suitable for download
 *
 * Usage:
 *   const zip = new TinyZip();
 *   zip.addFile("hello.txt", "Hello world");
 *   zip.addFile("docs/readme.md", "# Title");
 *   const blob = await zip.generateBlob();
 */

(function (global) {
  "use strict";

  const textEncoder = new TextEncoder();

  // ------------------------------------------------------------
  // CRC-32
  // ------------------------------------------------------------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ------------------------------------------------------------
  // Binary helpers
  // ------------------------------------------------------------
  function u16LE(value) {
    const b = new Uint8Array(2);
    b[0] = value & 0xFF;
    b[1] = (value >>> 8) & 0xFF;
    return b;
  }

  function u32LE(value) {
    const b = new Uint8Array(4);
    b[0] = value & 0xFF;
    b[1] = (value >>> 8) & 0xFF;
    b[2] = (value >>> 16) & 0xFF;
    b[3] = (value >>> 24) & 0xFF;
    return b;
  }

  function concatUint8Arrays(chunks, totalLength) {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function dosDateTime(date = new Date()) {
    let year = date.getFullYear();
    if (year < 1980) year = 1980;
    if (year > 2107) year = 2107;

    const month = date.getMonth() + 1; // 1-12
    const day = date.getDate();        // 1-31
    const hours = date.getHours();     // 0-23
    const minutes = date.getMinutes(); // 0-59
    const seconds = Math.floor(date.getSeconds() / 2); // ZIP stores 2-second units

    const dosTime = (hours << 11) | (minutes << 5) | seconds;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;

    return { dosTime, dosDate };
  }

  async function toUint8Array(input) {
    if (input == null) return new Uint8Array(0);

    if (input instanceof Uint8Array) {
      return input;
    }

    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (typeof Blob !== "undefined" && input instanceof Blob) {
      const buffer = await input.arrayBuffer();
      return new Uint8Array(buffer);
    }

    if (typeof input === "string") {
      return textEncoder.encode(input);
    }

    // Fallback for objects/numbers/booleans
    return textEncoder.encode(String(input));
  }

  function sanitizePath(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\.\.(\/|\\)/g, "");
  }

  // ------------------------------------------------------------
  // ZIP builder
  // ------------------------------------------------------------
  class TinyZip {
    constructor() {
      this._entries = [];
    }

    /**
     * Add a file to the zip.
     * @param {string} fileName
     * @param {string|Uint8Array|ArrayBuffer|Blob|any} data
     * @param {Object} [options]
     * @param {Date} [options.lastModified]
     */
    addFile(fileName, data, options = {}) {
      const safeName = sanitizePath(fileName);
      if (!safeName) {
        throw new Error("TinyZip.addFile: fileName must be a non-empty string.");
      }

      this._entries.push({
        fileName: safeName,
        data,
        lastModified: options.lastModified instanceof Date ? options.lastModified : new Date()
      });
    }

    /**
     * Remove all files.
     */
    clear() {
      this._entries = [];
    }

    /**
     * Number of files queued.
     * @returns {number}
     */
    count() {
      return this._entries.length;
    }

    /**
     * Generate zip bytes as Uint8Array.
     * @returns {Promise<Uint8Array>}
     */
    async generate() {
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const entry of this._entries) {
        const nameBytes = textEncoder.encode(entry.fileName);
        const contentBytes = await toUint8Array(entry.data);
        const crc = crc32(contentBytes);
        const size = contentBytes.length;
        const { dosTime, dosDate } = dosDateTime(entry.lastModified);

        // Local file header
        // signature            4 bytes  (0x04034b50)
        // version needed       2 bytes
        // general purpose bit  2 bytes  (bit 11 set for UTF-8)
        // compression method   2 bytes  (0 = store)
        // mod time             2 bytes
        // mod date             2 bytes
        // crc-32               4 bytes
        // compressed size      4 bytes
        // uncompressed size    4 bytes
        // file name length     2 bytes
        // extra field length   2 bytes
        const localHeader = concatUint8Arrays(
          [
            u32LE(0x04034b50),
            u16LE(20),        // version needed to extract
            u16LE(0x0800),    // UTF-8
            u16LE(0),         // store
            u16LE(dosTime),
            u16LE(dosDate),
            u32LE(crc),
            u32LE(size),
            u32LE(size),
            u16LE(nameBytes.length),
            u16LE(0),         // no extra field
            nameBytes
          ],
          30 + nameBytes.length
        );

        localParts.push(localHeader, contentBytes);

        // Central directory header
        // signature                 4 bytes (0x02014b50)
        // version made by           2 bytes
        // version needed            2 bytes
        // general purpose bit       2 bytes
        // compression method        2 bytes
        // mod time                  2 bytes
        // mod date                  2 bytes
        // crc-32                    4 bytes
        // compressed size           4 bytes
        // uncompressed size         4 bytes
        // file name length          2 bytes
        // extra field length        2 bytes
        // file comment length       2 bytes
        // disk number start         2 bytes
        // internal attrs            2 bytes
        // external attrs            4 bytes
        // local header offset       4 bytes
        const centralHeader = concatUint8Arrays(
          [
            u32LE(0x02014b50),
            u16LE(20),        // version made by
            u16LE(20),        // version needed
            u16LE(0x0800),    // UTF-8
            u16LE(0),         // store
            u16LE(dosTime),
            u16LE(dosDate),
            u32LE(crc),
            u32LE(size),
            u32LE(size),
            u16LE(nameBytes.length),
            u16LE(0),         // extra length
            u16LE(0),         // comment length
            u16LE(0),         // disk start
            u16LE(0),         // internal attrs
            u32LE(0),         // external attrs
            u32LE(offset),    // local header offset
            nameBytes
          ],
          46 + nameBytes.length
        );

        centralParts.push(centralHeader);

        offset += localHeader.length + contentBytes.length;
      }

      const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
      const centralOffset = offset;

      // End of central directory record
      // signature                  4 bytes (0x06054b50)
      // number of this disk        2 bytes
      // disk with central dir      2 bytes
      // entries on this disk       2 bytes
      // total entries              2 bytes
      // size of central directory  4 bytes
      // offset of central dir      4 bytes
      // comment length             2 bytes
      const eocd = concatUint8Arrays(
        [
          u32LE(0x06054b50),
          u16LE(0),
          u16LE(0),
          u16LE(this._entries.length),
          u16LE(this._entries.length),
          u32LE(centralSize),
          u32LE(centralOffset),
          u16LE(0)
        ],
        22
      );

      const totalLength =
        localParts.reduce((sum, p) => sum + p.length, 0) +
        centralSize +
        eocd.length;

      return concatUint8Arrays([...localParts, ...centralParts, eocd], totalLength);
    }

    /**
     * Generate a Blob containing the ZIP file.
     * @returns {Promise<Blob>}
     */
    async generateBlob() {
      const bytes = await this.generate();
      return new Blob([bytes], { type: "application/zip" });
    }
  }

  // Expose globally for extension scripts (popup/background/content).
  global.TinyZip = TinyZip;
})(typeof self !== "undefined" ? self : window);
