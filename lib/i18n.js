/**
 * lib/i18n.js — Lightweight Internationalization Helper
 * Works in content scripts, popups, and onboarding pages.
 */

(function (global) {
  "use strict";

  const i18n = {
    /**
     * Get a localized string by key with optional substitution parameters.
     * @param {string} key - The message key in messages.json
     * @param {string|string[]} [substitutions] - Optional substitutions for $1, $2, etc.
     * @param {string} [fallback] - Fallback text if key is missing or i18n unavailable
     * @returns {string}
     */
    t(key, substitutions, fallback = "") {
      try {
        if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
          const msg = chrome.i18n.getMessage(key, substitutions);
          if (msg) return msg;
        }
      } catch (e) {
        // Fall through to fallback
      }
      if (typeof substitutions === "string" && fallback) {
        return fallback.replace("$1", substitutions);
      }
      if (Array.isArray(substitutions) && fallback) {
        let res = fallback;
        substitutions.forEach((sub, i) => {
          res = res.replace(`$${i + 1}`, sub);
        });
        return res;
      }
      return fallback || key;
    },

    /**
     * Translates all elements inside a container containing data-i18n attributes:
     * - [data-i18n="key"]: sets element textContent
     * - [data-i18n-html="key"]: sets element innerHTML (for safe spans/bold text)
     * - [data-i18n-placeholder="key"]: sets placeholder attribute
     * - [data-i18n-title="key"]: sets title attribute
     * - [data-i18n-aria="key"]: sets aria-label attribute
     * @param {HTMLElement|Document} [root=document]
     */
    translateDOM(root = document) {
      if (!root) return;

      // textContent
      root.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (!key) return;
        const msg = this.t(key, null, el.textContent);
        if (msg) el.textContent = msg;
      });

      // innerHTML for formatted spans
      root.querySelectorAll("[data-i18n-html]").forEach((el) => {
        const key = el.getAttribute("data-i18n-html");
        if (!key) return;
        const msg = this.t(key, null, el.innerHTML);
        if (msg) el.innerHTML = msg;
      });

      // placeholder
      root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const key = el.getAttribute("data-i18n-placeholder");
        if (!key) return;
        const msg = this.t(key, null, el.getAttribute("placeholder") || "");
        if (msg) el.setAttribute("placeholder", msg);
      });

      // title
      root.querySelectorAll("[data-i18n-title]").forEach((el) => {
        const key = el.getAttribute("data-i18n-title");
        if (!key) return;
        const msg = this.t(key, null, el.getAttribute("title") || "");
        if (msg) el.setAttribute("title", msg);
      });

      // aria-label
      root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
        const key = el.getAttribute("data-i18n-aria");
        if (!key) return;
        const msg = this.t(key, null, el.getAttribute("aria-label") || "");
        if (msg) el.setAttribute("aria-label", msg);
      });
    }
  };

  // Expose globally for vanilla scripts
  global.i18n = i18n;

  // Support ES module environments if needed
  if (typeof module !== "undefined" && module.exports) {
    module.exports = i18n;
  }
})(typeof window !== "undefined" ? window : globalThis);
