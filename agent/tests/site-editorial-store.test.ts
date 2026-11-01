import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../lib/site-editorial-store.ts";
import * as tool from "../tools/site-editorial.ts";

const fixtures: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "site-editorial-store-"));
  fixtures.push(root);
  return root;
};
const put = (tree: string, relative: string, value: unknown) => {
  const path = join(tree, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const digestPath = "src/data/current/editorial-candidates.json";
const activityPath = "src/data/current/activity-candidates.json";
const journalPath = "src/data/edits.json";
const snapshotPath = "src/data/snapshot/editorial.json";
const storeUrl = new URL("../lib/site-editorial-store.ts", import.meta.url).href;

// Each fresh module import gets only fixture storage and explicitly disabled ingestion.
function importInChild(root: string, script: string, overrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test", MEMORY_DB_PATH: join(root, "memory.sqlite"), SITE_INGEST_ALLOW_IN_TESTS: "0" };
  delete env.DELABS_SITE_DIR;
  delete env.DELABS_EDITORIAL_AUTO;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { cwd: root, env: { ...env, ...overrides } });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("editorial store boundary", () => {
  test("the existing tool exports remain the same store functions and constants", () => {
    for (const name of Object.keys(store) as (keyof typeof store)[]) expect(tool[name]).toBe(store[name]);
  });

  test("import performs no filesystem operations even with configured paths", () => {
    const root = fixture();
    const result = importInChild(root, `
      import { mock } from "bun:test";
      const fail = () => { throw new Error("Filesystem operation during store import"); };
      mock.module("node:fs", () => ({ readFileSync: fail, writeFileSync: fail, renameSync: fail, mkdirSync: fail, existsSync: fail }));
      const store = await import(${JSON.stringify(storeUrl)});
      console.log(JSON.stringify({ site: store.SITE_DIR, auto: store.AUTO_PATH }));
    `, { DELABS_SITE_DIR: join(root, "unread-site"), DELABS_EDITORIAL_AUTO: join(root, "unwritten", "editorial.json") });
    expect(result).toEqual({ site: join(root, "unread-site"), auto: join(root, "unwritten", "editorial.json") });
    expect(readdirSync(root)).toEqual([]);
  });

  test("unset and empty environment values retain the original defaults and nullish semantics", () => {
    const root = fixture();
    const script = `const s = await import(${JSON.stringify(storeUrl)}); console.log(JSON.stringify([s.SITE_DIR, s.AUTO_PATH]));`;
    expect(importInChild(root, script)).toEqual(["/opt/delabs", "/var/lib/delabs-editorial/editorial.json"]);
    expect(importInChild(root, script, { DELABS_SITE_DIR: "", DELABS_EDITORIAL_AUTO: "" })).toEqual(["", ""]);
  });

  test("siteTree resolves a release symlink, keeps plain layouts, and uses the configured root by default", () => {
    const root = fixture();
    const release = join(root, "releases", "fixture");
    mkdirSync(join(release, "src", "data"), { recursive: true });
    symlinkSync(release, join(root, "current"));
    expect(store.siteTree(root)).toBe(join(root, "current"));
    expect(store.siteTree(release)).toBe(release);
    const result = importInChild(root, `const s = await import(${JSON.stringify(storeUrl)}); console.log(JSON.stringify(s.siteTree()));`, { DELABS_SITE_DIR: root });
    expect(result).toBe(join(root, "current"));
    const empty = join(root, "empty");
    mkdirSync(join(empty, "current"), { recursive: true });
    expect(store.siteTree(empty)).toBe(empty);
  });

  test("strict corpus reads accept arrays and propagate missing, malformed and non-array failures", () => {
    const root = fixture();
    const path = put(root, "valid.json", [{ id: "private-draft" }]);
    expect(store.readCorpus(path)).toEqual([{ id: "private-draft" }]);
    expect(() => store.readCorpus(join(root, "missing.json"))).toThrow(/нет корпуса.*missing.json/);
    writeFileSync(path, "{broken");
    expect(() => store.readCorpus(path)).toThrow(SyntaxError);
    put(root, "valid.json", { id: "not-an-array" });
    expect(() => store.readCorpus(path)).toThrow(`Invalid editorial corpus: ${path}`);
  });

  test("both private queues are read even when the published corpus is empty", () => {
    const root = fixture();
    const digests = [{ id: "unpublished", title: "Draft" }];
    const activities = [
      { id: "review", title: "Review me", activityReviewRequired: true },
      { id: "done", title: "Reviewed", activityReviewRequired: false },
    ];
    put(root, digestPath, digests);
    put(root, activityPath, activities);
    put(root, "src/data/current/digests.json", []);
    put(root, "src/data/current/activities.json", []);
    expect(store.readEditorialCandidates(root)).toEqual({ digests, activities });
  });

  for (const missing of [digestPath, activityPath]) {
    test(`a missing private queue fails closed: ${missing}`, () => {
      const root = fixture();
      put(root, digestPath, []);
      put(root, activityPath, []);
      rmSync(join(root, missing));
      expect(() => store.readEditorialCandidates(root)).toThrow(/нет корпуса/);
    });
    test(`a malformed private queue fails closed: ${missing}`, () => {
      const root = fixture();
      put(root, digestPath, []);
      put(root, activityPath, []);
      writeFileSync(join(root, missing), "{broken");
      expect(() => store.readEditorialCandidates(root)).toThrow(SyntaxError);
      put(root, missing, {});
      expect(() => store.readEditorialCandidates(root)).toThrow(/Invalid editorial corpus/);
    });
  }

  test("main rejects a missing activity queue before research or output/retry writes", () => {
    const root = fixture();
    put(root, journalPath, []);
    put(root, digestPath, [{ id: "pending", title: "Draft", origin: "telegram" }]);
    const auto = put(root, "auto.json", { digests: {} });
    const retries = put(root, "auto.json.retries.json", { "digests:other": 123 });
    const before = [readFileSync(auto, "utf8"), readFileSync(retries, "utf8")];
    const adapterUrl = new URL("../lib/codex-editorial.ts", import.meta.url).href;
    const toolUrl = new URL("../tools/site-editorial.ts", import.meta.url).href;
    const result = importInChild(root, `
      import { mock } from "bun:test";
      let researchCalls = 0;
      mock.module(${JSON.stringify(adapterUrl)}, () => ({ editorialResearch: () => { researchCalls++; throw new Error("Unexpected research"); } }));
      const { main } = await import(${JSON.stringify(toolUrl)});
      let error;
      try { await main(); } catch (failure) { error = failure.message; }
      console.log(JSON.stringify({ error, researchCalls }));
    `, { DELABS_SITE_DIR: root, DELABS_EDITORIAL_AUTO: auto });
    expect(result.error).toContain("activity-candidates.json");
    expect(result.researchCalls).toBe(0);
    expect([readFileSync(auto, "utf8"), readFileSync(retries, "utf8")]).toEqual(before);
  });

  test("activity publication-review state requires actual booleans", () => {
    const root = fixture();
    put(root, digestPath, []);
    for (const activityReviewRequired of [undefined, null, 0, 1, "false", "true"]) {
      put(root, activityPath, [{ id: "activity", title: "Draft", activityReviewRequired }]);
      expect(() => store.readEditorialCandidates(root)).toThrow("Activity candidate queue lacks publication-review state; rebuild site intake first");
    }
    put(root, activityPath, []);
    expect(store.readEditorialCandidates(root)).toEqual({ digests: [], activities: [] });
  });

  test("manual reads overlay the required journal on the optional snapshot", () => {
    const root = fixture();
    put(root, snapshotPath, { digests: {
      story: { title: "Snapshot title", summary: "Snapshot summary", body: "Protected body" },
      removed: { title: "Removed" },
    }, activities: { task: { title: "Activity title", intro: "Snapshot intro" } } });
    put(root, journalPath, [
      { kind: "digest", op: "patch", key: "story", value: { title: "Journal title", summary: "" } },
      { kind: "digest", op: "remove", key: "removed" },
      { kind: "activity", op: "patch", key: "task", value: { intro: "Journal intro" } },
    ]);
    expect(store.readManualEditorial(root)).toEqual({
      digests: { story: { title: "Journal title", summary: "", body: "Protected body" } },
      activities: { task: { title: "Activity title", intro: "Journal intro" } },
    });
    writeFileSync(join(root, snapshotPath), "{broken");
    expect(store.readManualEditorial(root).digests?.story).toEqual({ title: "Journal title", summary: "" });
    rmSync(join(root, snapshotPath));
    const journalOnlyActivity = store.readManualEditorial(root).activities?.task;
    expect(journalOnlyActivity?.intro).toBe("Journal intro");
    expect(Object.keys(journalOnlyActivity ?? {})).toEqual(["intro"]);
  });

  test("a missing, malformed or non-array live journal never falls back to an empty human layer", () => {
    const root = fixture();
    put(root, snapshotPath, {});
    expect(() => store.readManualEditorial(root)).toThrow();
    writeFileSync(join(root, journalPath), "{broken");
    expect(() => store.readManualEditorial(root)).toThrow(SyntaxError);
    put(root, journalPath, {});
    expect(() => store.readManualEditorial(root)).toThrow("Invalid editorial journal");
  });

  test("optional JSON reads retain their supplied fallback for read/parse errors and accept valid JSON unchanged", () => {
    const root = fixture();
    const fallback = { digests: {} };
    expect(store.readJson(join(root, "missing.json"), fallback)).toBe(fallback);
    expect(store.readJson(root, fallback)).toBe(fallback);
    const path = join(root, "optional.json");
    writeFileSync(path, "{broken");
    expect(store.readJson(path, fallback)).toBe(fallback);
    put(root, "optional.json", null);
    expect(store.readJson(path, fallback)).toBeNull();
    put(root, "optional.json", { "digests:story": 123 });
    expect(store.readJson<unknown>(path, fallback)).toEqual({ "digests:story": 123 });
  });

  test("atomic writes create parents, replace complete UTF-8 JSON and leave no temporary file after success", () => {
    const root = fixture();
    const path = join(root, "state", "nested", "editorial.json");
    const first = { digests: { story: { title: "Проверенная новость" } } };
    store.writeAtomic(path, first);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(first, null, 2) + "\n");
    const second = { activities: { task: { title: "Обновлённая карточка" } } };
    store.writeAtomic(path, second);
    expect(store.readJson(path, {})).toEqual(second);
    expect(readdirSync(join(path, ".."))).toEqual(["editorial.json"]);
  });

  test("atomic-write failures propagate and preserve the previous destination", () => {
    const root = fixture();
    const path = put(root, "editorial.json", { old: true });
    const original = readFileSync(path, "utf8");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => store.writeAtomic(path, circular)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    const blocked = join(root, "directory-target");
    mkdirSync(blocked);
    expect(() => store.writeAtomic(blocked, { new: true })).toThrow();
    expect(existsSync(blocked)).toBe(true);
    // Existing rename failures leave the sibling temporary file for diagnosis.
    const temporary = readdirSync(root).filter(name => /^\.\d+\.tmp$/.test(name));
    expect(temporary).toHaveLength(1);
    expect(readFileSync(join(root, temporary[0]), "utf8")).toBe('{\n  "new": true\n}\n');
  });
});
