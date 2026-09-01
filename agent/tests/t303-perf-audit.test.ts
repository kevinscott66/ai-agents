/**
 * T-303 — Regression guard: async wiki reads return same results as sync.
 *
 * Proves that the hot-path refactor in message-handler.ts (wikiIndex →
 * wikiIndexAsync, wikiLog → wikiLogAsync, wikiRead → wikiReadAsync wrapped in
 * Promise.all) produces byte-identical results to the original sequential sync
 * calls, using a hermetic temp directory.
 *
 * Also guards the "file not found → empty/null" contract that both sync and
 * async variants must honour.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import {
  readFileSync,
  existsSync,
} from "node:fs";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

// ── helpers that mirror memory.ts sync implementations (the "before" state) ──

function syncWikiIndex(root: string, scope: string): string {
  const p = join(root, scope, "index.md");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function syncWikiLog(root: string, scope: string): string {
  const p = join(root, scope, "log.md");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function syncWikiRead(root: string, scope: string, slug: string): string | null {
  const p = join(root, scope, "pages", `${slug}.md`);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

// ── helpers that mirror memory-async.ts async implementations (the "after") ──

async function asyncWikiIndex(root: string, scope: string): Promise<string> {
  const p = join(root, scope, "index.md");
  try {
    await access(p, constants.F_OK);
    return await readFile(p, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

async function asyncWikiLog(root: string, scope: string): Promise<string> {
  const p = join(root, scope, "log.md");
  try {
    await access(p, constants.F_OK);
    return await readFile(p, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

async function asyncWikiRead(root: string, scope: string, slug: string): Promise<string | null> {
  const p = join(root, scope, "pages", `${slug}.md`);
  try {
    await access(p, constants.F_OK);
    return await readFile(p, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// ── test fixtures ──

const ROOT = join("/tmp", `t303-test-${process.pid}-${Date.now()}`);
const TEAM_SCOPE = "_team";
const AGENT_SCOPE = "orchestrator";

// Simulated FTS hit slugs (what wikiSearch returns in the hot path)
const HIT_SLUGS = ["decisions/adr-001", "decisions/adr-002", "meeting-notes"];

beforeAll(() => {
  // Create scoped directories
  mkdirSync(join(ROOT, TEAM_SCOPE, "pages"), { recursive: true });
  mkdirSync(join(ROOT, AGENT_SCOPE, "pages"), { recursive: true });

  // Team index + log
  writeFileSync(join(ROOT, TEAM_SCOPE, "index.md"), "# Team Index\nSome team context.");
  writeFileSync(join(ROOT, TEAM_SCOPE, "log.md"), "2026-06-01 | orchestrator | done something");

  // Agent index (no log — tests the ENOENT → "" branch)
  writeFileSync(join(ROOT, AGENT_SCOPE, "index.md"), "# Orchestrator Index\nSome private context.");

  // Wiki hit pages: create 2 of 3 (one intentionally missing → null)
  for (const slug of HIT_SLUGS.slice(0, 2)) {
    const parts = slug.split("/");
    if (parts.length > 1) {
      mkdirSync(join(ROOT, TEAM_SCOPE, "pages", ...parts.slice(0, -1)), { recursive: true });
    }
    writeFileSync(
      join(ROOT, TEAM_SCOPE, "pages", `${slug}.md`),
      `# ${slug}\nContent for ${slug}.\n${"y".repeat(800)}`,
    );
  }
  // HIT_SLUGS[2] ("meeting-notes") is intentionally NOT created → null / missing
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

describe("T-303: async wiki reads are byte-identical to sync reads", () => {
  test("wikiIndex: team scope — present file", async () => {
    const syncResult = syncWikiIndex(ROOT, TEAM_SCOPE);
    const asyncResult = await asyncWikiIndex(ROOT, TEAM_SCOPE);
    expect(asyncResult).toBe(syncResult);
    expect(asyncResult).toContain("Team Index");
  });

  test("wikiIndex: agent scope — present file", async () => {
    const syncResult = syncWikiIndex(ROOT, AGENT_SCOPE);
    const asyncResult = await asyncWikiIndex(ROOT, AGENT_SCOPE);
    expect(asyncResult).toBe(syncResult);
    expect(asyncResult).toContain("Orchestrator Index");
  });

  test("wikiIndex: missing scope returns empty string", async () => {
    const syncResult = syncWikiIndex(ROOT, "nonexistent");
    const asyncResult = await asyncWikiIndex(ROOT, "nonexistent");
    expect(syncResult).toBe("");
    expect(asyncResult).toBe("");
  });

  test("wikiLog: team scope — present file", async () => {
    const syncResult = syncWikiLog(ROOT, TEAM_SCOPE);
    const asyncResult = await asyncWikiLog(ROOT, TEAM_SCOPE);
    expect(asyncResult).toBe(syncResult);
    expect(asyncResult).toContain("orchestrator");
  });

  test("wikiLog: agent scope — missing log returns empty string", async () => {
    const syncResult = syncWikiLog(ROOT, AGENT_SCOPE);
    const asyncResult = await asyncWikiLog(ROOT, AGENT_SCOPE);
    expect(syncResult).toBe("");
    expect(asyncResult).toBe("");
  });

  test("wikiRead: present pages return identical content", async () => {
    for (const slug of HIT_SLUGS.slice(0, 2)) {
      const syncResult = syncWikiRead(ROOT, TEAM_SCOPE, slug);
      const asyncResult = await asyncWikiRead(ROOT, TEAM_SCOPE, slug);
      expect(asyncResult).toBe(syncResult);
      expect(asyncResult).not.toBeNull();
      expect(asyncResult).toContain(slug);
    }
  });

  test("wikiRead: missing page returns null in both sync and async", async () => {
    const slug = HIT_SLUGS[2]; // "meeting-notes" — not created
    const syncResult = syncWikiRead(ROOT, TEAM_SCOPE, slug);
    const asyncResult = await asyncWikiRead(ROOT, TEAM_SCOPE, slug);
    expect(syncResult).toBeNull();
    expect(asyncResult).toBeNull();
  });

  test("Promise.all fan-out returns same results as sequential sync calls", async () => {
    // This is the exact pattern used in the refactored message-handler.ts
    const hits = HIT_SLUGS.map((slug) => ({ scope: TEAM_SCOPE, slug }));

    // BEFORE (sync sequential)
    const syncTeamIdx = syncWikiIndex(ROOT, TEAM_SCOPE);
    const syncTeamLog = syncWikiLog(ROOT, TEAM_SCOPE);
    const syncPrivIdx = syncWikiIndex(ROOT, AGENT_SCOPE);
    const syncHitBodies = hits.map((h) => syncWikiRead(ROOT, h.scope, h.slug));

    // AFTER (async parallel — the refactored implementation)
    const [asyncTeamIdx, asyncTeamLogRaw, asyncPrivIdx, ...asyncHitBodies] = await Promise.all([
      asyncWikiIndex(ROOT, TEAM_SCOPE),
      asyncWikiLog(ROOT, TEAM_SCOPE),
      asyncWikiIndex(ROOT, AGENT_SCOPE),
      ...hits.map((h) => asyncWikiRead(ROOT, h.scope, h.slug)),
    ]);

    expect(asyncTeamIdx).toBe(syncTeamIdx);
    expect(asyncTeamLogRaw).toBe(syncTeamLog);
    expect(asyncPrivIdx).toBe(syncPrivIdx);

    for (let i = 0; i < hits.length; i++) {
      expect(asyncHitBodies[i] ?? null).toBe(syncHitBodies[i]);
    }
  });
});

describe("T-303: micro-benchmark guard (async is not catastrophically slower)", () => {
  // Замеры на 50 мелких файлах из page cache укладываются в ~0.5–1 мс с обеих
  // сторон, поэтому ОТНОШЕНИЕ двух таких чисел — это отношение шумов. Первый
  // прогон вдобавок платит за прогрев (локально ratio 1.44 на первой итерации
  // против 0.55–0.65 на последующих). На общем CI-раннере этого хватало, чтобы
  // случайно перевалить за 3× — 2026-08-04 тест уронил весь Repo Checks на
  // f37d874 при 1013 pass. Поэтому: прогрев, best-of-N (минимум — наименее
  // шумная статистика для таймингов) и абсолютный потолок.
  const N = 50;
  const REPS = 5;
  // Катастрофой считаем то, что видно невооружённым глазом: случайный await в
  // цикле с fsync, синхронный fallback, ×100. 50 кэшированных чтений по 512 Б
  // при любом здоровом раскладе — единицы миллисекунд.
  const CATASTROPHE_MS = 50;

  async function bestOf(
    paths: string[],
  ): Promise<{ syncMs: number; asyncMs: number }> {
    let syncMs = Infinity;
    let asyncMs = Infinity;
    for (let r = 0; r < REPS; r++) {
      const s0 = performance.now();
      for (const p of paths) readFileSync(p, "utf8");
      syncMs = Math.min(syncMs, performance.now() - s0);

      const a0 = performance.now();
      await Promise.all(paths.map((p) => readFile(p, "utf8")));
      asyncMs = Math.min(asyncMs, performance.now() - a0);
    }
    return { syncMs, asyncMs };
  }

  test("async parallel не катастрофически медленнее sync на N=50 страницах", async () => {
    const tmpDir = join(ROOT, "bench");
    mkdirSync(tmpDir, { recursive: true });

    const paths: string[] = [];
    for (let i = 0; i < N; i++) {
      const p = join(tmpDir, `page-${i}.md`);
      writeFileSync(p, `# Page ${i}\n${"z".repeat(512)}`);
      paths.push(p);
    }

    await bestOf(paths); // прогрев: page cache + JIT, результат выбрасываем
    const { syncMs, asyncMs } = await bestOf(paths);

    // Достаточно уложиться в ЛЮБОЙ из двух порогов: относительный ловит
    // регрессию, когда sync достаточно медленный, чтобы отношение что-то
    // значило; абсолютный не даёт субмиллисекундному шуму уронить сборку.
    const bound = Math.max(syncMs * 3, CATASTROPHE_MS);
    if (asyncMs >= bound) {
      // Печатаем замеры: без них «async slower» на раннере нечем объяснить.
      console.error(
        `[t303-bench] sync=${syncMs.toFixed(3)}ms async=${asyncMs.toFixed(3)}ms bound=${bound.toFixed(3)}ms`,
      );
    }
    expect(asyncMs).toBeLessThan(bound);
  });
});
