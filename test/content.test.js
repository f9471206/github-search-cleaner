// Unit tests for the part of content.js that decides what to delete from the search
// history. Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { prune, removeOne, removeAll } = require("../content.js");

const KEY = "github-search-history";

// Minimal stand-in for the browser's localStorage
function useStorage(initial) {
  const map = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return map;
}

// prune() edits `data` in place; return the result together with the count
function pruned(data, text) {
  const removed = prune(data, text);
  return { removed, data };
}

// ---------- prune: the format GitHub uses today (an array of query strings) ----------

test("removes a query from a list of strings", () => {
  assert.deepEqual(pruned(["puppeteer", "repo:nodejs/node stream", "jsdom"], "jsdom"), {
    removed: 1,
    data: ["puppeteer", "repo:nodejs/node stream"],
  });
});

test("removes every copy of a repeated query", () => {
  assert.deepEqual(pruned(["foo", "bar", "foo"], "foo"), { removed: 2, data: ["bar"] });
});

test("does not match part of a longer query", () => {
  assert.deepEqual(pruned(["repo:a/b foo"], "foo"), { removed: 0, data: ["repo:a/b foo"] });
});

test("ignores extra whitespace in the stored query", () => {
  assert.deepEqual(pruned([" repo:a/b   foo ", "foo"], "repo:a/b foo"), {
    removed: 1,
    data: ["foo"],
  });
});

test("leaves the data alone when nothing matches", () => {
  assert.deepEqual(pruned(["foo", "bar"], "baz"), { removed: 0, data: ["foo", "bar"] });
});

// ---------- prune: entries stored as objects, in case the format changes ----------

test("removes an object entry by its query field", () => {
  const data = [
    { query: "foo", scope: "GITHUB" },
    { query: "bar", scope: "GITHUB" },
  ];
  assert.deepEqual(pruned(data, "foo"), {
    removed: 1,
    data: [{ query: "bar", scope: "GITHUB" }],
  });
});

test("does not delete entries that merely share a field value", () => {
  const data = [
    { query: "foo", scope: "GITHUB" },
    { query: "bar", scope: "GITHUB" },
  ];
  assert.equal(prune(data, "GITHUB"), 0);
  assert.equal(data.length, 2);
});

test("deletes only the entry whose query equals a shared field value", () => {
  const data = [
    { query: "GITHUB", scope: "GITHUB" },
    { query: "bar", scope: "GITHUB" },
  ];
  assert.deepEqual(pruned(data, "GITHUB"), {
    removed: 1,
    data: [{ query: "bar", scope: "GITHUB" }],
  });
});

test("treats entries that differ only in numbers as the same search", () => {
  const data = [
    { query: "foo", ts: 1 },
    { query: "foo", ts: 2 },
    { query: "bar", ts: 3 },
  ];
  assert.deepEqual(pruned(data, "foo"), { removed: 2, data: [{ query: "bar", ts: 3 }] });
});

test("finds entries nested under a key", () => {
  const data = { version: 1, items: [{ q: "foo" }, { q: "bar" }] };
  assert.deepEqual(pruned(data, "foo"), {
    removed: 1,
    data: { version: 1, items: [{ q: "bar" }] },
  });
});

test("removes an entry from a map keyed by query", () => {
  const data = { foo: { ts: 1 }, bar: { ts: 2 } };
  assert.deepEqual(pruned(data, "foo"), { removed: 1, data: { bar: { ts: 2 } } });
});

// ---------- removeOne ----------

test("removeOne deletes the first candidate found in storage and returns it", () => {
  const map = useStorage({ [KEY]: JSON.stringify(["repo:a/b foo", "foo", "bar"]) });
  // Candidates as content.js builds them: the whole query first, fragments after
  assert.equal(removeOne(["no such query", "repo:a/b foo", "foo"]), "repo:a/b foo");
  assert.deepEqual(JSON.parse(map.get(KEY)), ["foo", "bar"]);
});

test("removeOne returns null and writes nothing when no candidate is stored", () => {
  const original = JSON.stringify(["foo", "bar"]);
  const map = useStorage({ [KEY]: original });
  assert.equal(removeOne(["baz", "qux"]), null);
  assert.equal(map.get(KEY), original);
});

test("removeOne leaves other storage keys untouched", () => {
  const map = useStorage({
    [KEY]: JSON.stringify(["foo"]),
    "other-history": JSON.stringify(["foo"]),
  });
  assert.equal(removeOne(["foo"]), "foo");
  assert.deepEqual(JSON.parse(map.get(KEY)), []);
  assert.deepEqual(JSON.parse(map.get("other-history")), ["foo"]);
});

test("removeOne copes with a missing or unreadable history", () => {
  useStorage({});
  assert.equal(removeOne(["foo"]), null);
  const map = useStorage({ [KEY]: "not json" });
  assert.equal(removeOne(["foo"]), null);
  assert.equal(map.get(KEY), "not json");
});

// ---------- removeAll ----------

test("removeAll deletes the history key and nothing else", () => {
  const map = useStorage({ [KEY]: JSON.stringify(["foo"]), theme: "dark" });
  assert.equal(removeAll(), 1);
  assert.deepEqual([...map.keys()], ["theme"]);
});

test("removeAll reports zero when there is no history", () => {
  useStorage({ theme: "dark" });
  assert.equal(removeAll(), 0);
});
