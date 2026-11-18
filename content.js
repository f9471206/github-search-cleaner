// Adds to the "Recent" section of the GitHub search dropdown:
//   1. a "Clear" button next to the heading (deletes all recent searches)
//   2. a "×" button on the right of each entry (deletes only that entry)
(() => {
  const HEADING_TEXT = "Recent";      // section heading in the search dropdown
  const KEY_RE = /^github-search-history$/; // localStorage key that holds search history
  const RELOAD_AFTER_CLEAR = true;    // reload the page after clearing everything
  const CONFIRM_MS = 4000;            // how long "Clear" waits for the confirming click
  const SCAN_DELAY_MS = 150;          // delay between a page change and the scan for it
  const MAX_RUN_PARTS = 12;           // entries with more text pieces skip the joined runs
  const MARK = "data-gh-search-cleaner";
  const HIDDEN = MARK + "-hidden";    // set on entries hidden by their "×" button
  const HEADING_SELECTOR = "h2, h3, h4, h5, h6, span, div, li";

  const actions = new WeakMap();      // button -> what to do on click
  const clearButtons = new Set();     // our "Clear" buttons currently on the page
  // Entries deleted one by one during this page load: entry signature -> stored query
  const deleted = new Map();

  // Collapse whitespace so text from the page and text from storage compare equal
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  // ---------- Locating elements on the page ----------

  function isSearchInput(input) {
    return /search/i.test(`${input.placeholder} ${input.getAttribute("aria-label") || ""}`);
  }

  // Make sure this "Recent" is inside the search dropdown, not elsewhere on the page:
  // one of its nearest 12 ancestors must also contain a search box
  function isInSearchPanel(el, searchAncestors) {
    let node = el.parentElement;
    for (let i = 0; node && i < 12; i++, node = node.parentElement) {
      if (searchAncestors.has(node)) return true;
    }
    return false;
  }

  // Every entry under the Recent heading (up to the next section heading, e.g. Repositories)
  function recentItems(heading) {
    let root = heading.parentElement;
    for (let i = 0; root && i < 6 && !root.querySelector('[role="option"]'); i++) {
      root = root.parentElement;
    }
    if (!root) return [];
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const nextHeading =[...root.querySelectorAll(heading.tagName)].find(
      (h) =>
        h !== heading &&
        h.className === heading.className &&
        !h.closest('[role="option"]') &&
        heading.compareDocumentPosition(h) & FOLLOWING
    );
    return [...root.querySelectorAll('[role="option"]')].filter(
      (o) =>
        heading.compareDocumentPosition(o) & FOLLOWING &&
        (!nextHeading || o.compareDocumentPosition(nextHeading) & FOLLOWING)
    );
  }

  // Pieces of text shown inside one entry (excluding our own buttons), in document
  // order. Whitespace between two pieces is kept as a leading space on the later one.
  function textParts(item) {
    const parts = [];
    let gap = "";
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest(`[${MARK}]`)) continue;
      const t = n.textContent;
      if (t.trim()) {
        parts.push(gap + t);
        gap = "";
      } else if (t) {
        gap = " ";
      }
    }
    return parts;
  }

  // Strings that may be this entry's query as saved in storage, most specific first.
  // GitHub may split one query over several elements (e.g. to colour "repo:"), so
  // besides each piece of text we also try every run of neighbouring pieces joined
  // together, longest first. The first candidate doubles as the entry's signature.
  function candidates(item) {
    const fromAttributes = [];
    for (const el of [item, ...item.querySelectorAll("[data-value], a[href]")]) {
      if (el.closest(`[${MARK}]`)) continue;
      const value = el.getAttribute("data-value");
      if (value) fromAttributes.push(norm(value));
      if (el instanceof HTMLAnchorElement) {
        try {
          const q = new URL(el.href).searchParams.get("q");
          if (q) fromAttributes.push(norm(q));
        } catch {}
      }
    }

    const parts = textParts(item);
    const runs = [];
    if (parts.length <= MAX_RUN_PARTS) {
      for (let i = 0; i < parts.length; i++) {
        for (let j = i; j < parts.length; j++) {
          runs.push(norm(parts.slice(i, j + 1).join("")));
        }
      }
    } else {
      runs.push(norm(parts.join("")), ...parts.map(norm));
    }
    runs.sort((a, b) => b.length - a.length);

    return [...new Set([...fromAttributes, ...runs])].filter(Boolean);
  }

  // ---------- Working with localStorage ----------

  function candidateKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (KEY_RE.test(key)) keys.push(key);
    }
    return keys;
  }

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // Is stored value `x` the (already normalized) query `text`?
  const same = (x, text) => typeof x === "string" && norm(x) === text;

  // What makes two history entries "the same search": their string fields
  // (numbers such as timestamps or counters are ignored)
  const identity = (o) =>
    JSON.stringify(Object.entries(o).filter(([, x]) => typeof x === "string").sort());

  // Does list entry `v` stand for the search `text`?
  // A field equal to `text` only counts if every other entry sharing that field value
  // is the same search. Otherwise the field is a shared label (e.g. a scope), and
  // matching on it would delete unrelated searches.
  function matchesEntry(list, v, text) {
    if (same(v, text)) return true;
    if (!isObj(v)) return false;
    const id = identity(v);
    return Object.keys(v).some(
      (k) =>
        same(v[k], text) &&
        list.every((o) => !isObj(o) || !same(o[k], text) || identity(o) === id)
    );
  }

  // Remove entries matching `text` from parsed JSON; returns how many were removed
  function prune(node, text) {
    let n = 0;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (matchesEntry(node, node[i], text)) {
          node.splice(i, 1);
          n++;
        } else {
          n += prune(node[i], text);
        }
      }
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (same(k, text)) {
          delete node[k];
          n++;
        } else {
          n += prune(node[k], text);
        }
      }
    }
    return n;
  }

  // Delete a single query: tries `texts` in order and stops at the first one found in
  // storage. Returns that text, or null if none was found.
  function removeOne(texts) {
    const stores = [];
    for (const key of candidateKeys()) {
      try {
        stores.push({ key, data: JSON.parse(localStorage.getItem(key)) });
      } catch {}
    }
    for (const text of texts) {
      let hit = false;
      for (const store of stores) {
        if (prune(store.data, text)) {
          localStorage.setItem(store.key, JSON.stringify(store.data));
          hit = true;
        }
      }
      if (hit) return text;
    }
    return null;
  }

  // Delete all search history; returns how many storage keys were removed
  function removeAll() {
    const keys = candidateKeys();
    keys.forEach((key) => localStorage.removeItem(key));
    return keys.length;
  }

  // The user searched for `query`: stop treating the queries in it as deleted, so the
  // new history entry survives
  function revive(query) {
    const q = norm(query || "");
    if (!q) return;
    for (const [signature, text] of deleted) {
      if (q.includes(text)) deleted.delete(signature);
    }
  }

  // Under Node.js there is no page to work on: hand the storage logic to the unit
  // tests (test/content.test.js) and stop here. Browsers never take this branch.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { prune, removeOne, removeAll };
    return;
  }

  // ---------- Buttons ----------

  function makeButton(kind, label, title, css, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute(MARK, kind);
    btn.style.cssText = "background:transparent;font:inherit;cursor:pointer;" + css;
    actions.set(btn, onClick);
    return btn;
  }

  function setLabel(btn, label, title) {
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }

  // A visible, editable textarea with content may be an unsaved comment or issue,
  // which a reload would throw away
  function hasDraftText() {
    return [...document.querySelectorAll("textarea")].some(
      (t) => !t.readOnly && !t.disabled && t.value.trim() && t.getClientRects().length > 0
    );
  }

  function addClearAll(heading) {
    const css =
      "margin-left:8px;padding:0 6px;border:1px solid var(--borderColor-default,#d0d7de);" +
      "border-radius:6px;color:var(--fgColor-danger,#cf222e);font-size:11px;line-height:18px;";
    const idleTitle = "Delete all recent searches";
    let disarm = null; // pending timer while the button waits for the confirming click
    const button = makeButton("all", "Clear", idleTitle, css, (btn) => {
      // The first click only arms the button; a second click within CONFIRM_MS deletes
      if (!disarm) {
        setLabel(btn, "Confirm?", "Click again to delete all recent searches");
        disarm = setTimeout(() => {
          disarm = null;
          setLabel(btn, "Clear", idleTitle);
        }, CONFIRM_MS);
        return;
      }
      clearTimeout(disarm);
      disarm = null;

      const items = recentItems(heading);
      const removed = removeAll();
      if (!removed) {
        setLabel(btn, "Nothing found", "No search history in browser storage");
      } else if (RELOAD_AFTER_CLEAR && !hasDraftText()) {
        location.reload();
        return;
      } else {
        // Not reloading: hide what is on screen instead
        for (const item of items) item.style.display = "none";
        setLabel(
          btn,
          "Cleared",
          "Search history deleted. The page was not reloaded because it has unsaved text."
        );
      }
      btn.disabled = true;
    });
    clearButtons.add(button);
    heading.append(button);
  }

  function hide(item) {
    item.style.display = "none";
    item.setAttribute(HIDDEN, "");
  }

  function addDeleteOne(item) {
    if (getComputedStyle(item).position === "static") item.style.position = "relative";
    const css =
      "position:absolute;right:8px;top:50%;transform:translateY(-50%);z-index:1;" +
      "width:22px;height:22px;padding:0;border:0;border-radius:6px;" +
      "color:var(--fgColor-muted,#656d76);font-size:16px;line-height:22px;text-align:center;";
    item.append(
      makeButton("one", "×", "Delete this recent search", css, (btn) => {
        const texts = candidates(item);
        const found = removeOne(texts);
        if (found === null) {
          setLabel(btn, "?", "Could not find this entry in browser storage");
          return;
        }
        deleted.set(texts[0], found);
        hide(item);
      })
    );
  }

  // Intercept at the top level so GitHub does not treat the click as selecting the
  // entry or blur the search box
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    window.addEventListener(
      type,
      (e) => {
        const btn = e.target instanceof Element && e.target.closest(`button[${MARK}]`);
        if (!btn) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === "click" && !btn.disabled) actions.get(btn)?.(btn);
      },
      true
    );
  }

  // ---------- Noticing that the user searched again ----------
  // A deleted query that the user searches for again must be allowed back into the
  // history. Three signals, since no single one covers every way of searching.

  // 1. Enter in an input
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && e.target instanceof HTMLInputElement) revive(e.target.value);
    },
    true
  );

  // 2. Click on a suggestion in a dropdown
  window.addEventListener(
    "click",
    (e) => {
      if (!deleted.size || !(e.target instanceof Element)) return;
      if (e.target.closest(`button[${MARK}]`)) return;
      const option = e.target.closest('[role="option"]');
      if (option) revive(option.textContent);
    },
    true
  );

  // 3. Navigation to a URL that carries a query (checked at the start of every scan)
  let lastHref = location.href;
  function noteNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    revive(new URLSearchParams(location.search).get("q"));
  }

  // ---------- Scanning the page ----------

  const dirty = new Set(); // elements whose content changed since the last scan
  let timer = null;

  // Queue `el` (and everything inside it) for the next scan. The timer is not
  // restarted by later changes, so a page that keeps changing still gets scanned.
  function schedule(el) {
    dirty.add(el);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, SCAN_DELAY_MS);
  }

  function isRecentHeading(el, searchAncestors) {
    return (
      el.childElementCount === 0 &&
      el.textContent.trim() === HEADING_TEXT &&
      el.matches(HEADING_SELECTOR) &&
      isInSearchPanel(el, searchAncestors())
    );
  }

  function scan() {
    noteNavigation();

    // Every element that contains a search box, collected at most once per scan and
    // only if a possible heading turns up
    let ancestors = null;
    const searchAncestors = () => {
      if (ancestors) return ancestors;
      ancestors = new Set();
      for (const input of document.querySelectorAll("input")) {
        if (!isSearchInput(input)) continue;
        for (let p = input.parentElement; p; p = p.parentElement) ancestors.add(p);
      }
      return ancestors;
    };

    // Only look at what changed, and at each changed area once: skip elements that
    // have left the page or sit inside another changed element
    const roots = [...dirty].filter((el) => {
      if (!el.isConnected) return false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (dirty.has(p)) return false;
      }
      return true;
    });
    dirty.clear();

    for (const root of roots) {
      // Copies of our buttons made by the page (e.g. restored from a navigation cache)
      // have no click action; drop them so that fresh ones get added
      for (const btn of root.querySelectorAll(`button[${MARK}]`)) {
        if (!actions.has(btn)) btn.remove();
      }
      // 1. Add "Clear" to Recent headings that do not have it yet
      for (const el of [root, ...root.querySelectorAll(HEADING_SELECTOR)]) {
        if (isRecentHeading(el, searchAncestors)) addClearAll(el);
      }
    }

    // 2. Add "×" to every entry under Recent
    for (const clearBtn of clearButtons) {
      if (!clearBtn.isConnected) {
        clearButtons.delete(clearBtn);
        continue;
      }
      for (const item of recentItems(clearBtn.parentElement)) {
        if (deleted.size || item.hasAttribute(HIDDEN)) {
          const signature = candidates(item)[0];
          if (deleted.has(signature)) {
            // GitHub re-rendered (or re-saved) a deleted entry from in-memory data:
            // delete it again and keep it hidden
            removeOne([deleted.get(signature)]);
            hide(item);
            continue;
          }
          // Hidden earlier, but now searched again or reused for another entry
          if (item.hasAttribute(HIDDEN)) {
            item.removeAttribute(HIDDEN);
            item.style.display = "";
          }
        }
        if (!item.querySelector(`button[${MARK}="one"]`)) addDeleteOne(item);
      }
    }
  }

  new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target instanceof Element ? record.target : record.target.parentElement;
      if (el) schedule(el);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Safety net for anything the incremental scan missed: recheck the whole page when
  // a search box gets focus, which is when the dropdown opens
  window.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof HTMLInputElement && isSearchInput(e.target)) {
        schedule(document.documentElement);
      }
    },
    true
  );

  dirty.add(document.documentElement);
  scan();
})();
