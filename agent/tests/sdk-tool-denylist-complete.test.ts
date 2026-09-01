/**
 * Денилист встроенных тулзов SDK не должен стареть молча (аудит 2026-08-04).
 *
 * Роль-бот обязан ходить только через наши MCP-тулзы (`mcp__team__*`), где есть
 * гейт, рейт-лимит и запись в agent_actions. Всё встроенное в Claude Code
 * перечислено в `disallowedTools` — то есть защита это СПИСОК ИМЁН, а имена
 * задаёт SDK. Список писался под старый набор и разъехался: `Task` — прежнее
 * имя спаунера субагентов, сейчас он `Agent`, и запрещён не был. Субагент
 * поднимается со своим набором тулзов, поэтому одна эта дыра обесценивала весь
 * список. Рядом нашлись `REPL` (выполнение кода), `Workflow` (веер субагентов),
 * `CronCreate`/`ScheduleWakeup`/`Monitor` (фоновая автономия, осознанно
 * отложенная — CLAUDE.md §6) и `Artifact` (публикация публичной страницы мимо
 * draft+approve).
 *
 * Поэтому тест сверяет список не с копией имён, а с tool-схемами УСТАНОВЛЕННОГО
 * пакета: после `bun update` новое имя тулза уронит тест, а не тихо откроется
 * ботам в проде.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const RUNTIME = readFileSync(
  new URL("../lib/agent-sdk-runtime.ts", import.meta.url),
  "utf8",
);

/** Имена тулзов, как их знает установленный SDK. */
function sdkToolNames(): string[] {
  const dts = readFileSync(
    new URL(
      "../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const names = new Set<string>();
  for (const m of dts.matchAll(/\b([A-Z][A-Za-z]+)Input\b/g)) names.add(m[1]!);
  return [...names].sort();
}

/**
 * Схемы зовутся File*, а сами тулзы — коротко. Карта явная: молчаливое
 * сопоставление по префиксу однажды и породило `Task` вместо `Agent`.
 */
const SCHEMA_TO_TOOL: Record<string, string> = {
  FileRead: "Read",
  FileEdit: "Edit",
  FileWrite: "Write",
};

/** Что мы сознательно оставляем открытым. */
const INTENTIONALLY_ALLOWED = new Set([
  "WebSearch", // read-only ресёрч для контент-ролей
  "WebFetch",
]);

function denylist(): string[] {
  const start = RUNTIME.indexOf("const DISALLOWED = [");
  expect(start).toBeGreaterThan(-1);
  const body = RUNTIME.slice(start, RUNTIME.indexOf("];", start));
  return [...body.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
}

describe("денилист покрывает весь набор SDK", () => {
  test("схемы тулзов из пакета вообще читаются", () => {
    // Если SDK переедет и файл исчезнет, тест должен упасть здесь, а не молча
    // проверять пустой список.
    expect(sdkToolNames().length).toBeGreaterThan(10);
  });

  test("каждый встроенный тулз либо запрещён, либо разрешён осознанно", () => {
    const denied = new Set(denylist());
    const missing = sdkToolNames()
      .map((n) => SCHEMA_TO_TOOL[n] ?? n)
      .filter((n) => !denied.has(n) && !INTENTIONALLY_ALLOWED.has(n));

    expect(missing).toEqual([]);
  });

  test("спаунер субагентов закрыт под обоими именами", () => {
    // `Agent` — текущее имя, `Task` — прежнее: SDK на проде и локально может
    // отличаться версией, поэтому держим оба.
    const denied = new Set(denylist());
    expect(denied.has("Agent")).toBe(true);
    expect(denied.has("Task")).toBe(true);
  });

  test("выполнение кода и файловая система закрыты", () => {
    const denied = new Set(denylist());
    for (const t of ["Bash", "REPL", "Read", "Write", "Edit"]) {
      expect(denied.has(t)).toBe(true);
    }
  });

  test("WebSearch открыт, native WebFetch закрыт", () => {
    // WebFetch is now served by the address-pinned MCP tool; the native CLI
    // implementation must stay denied because it bypasses that boundary.
    const denied = new Set(denylist());
    expect(denied.has("WebSearch")).toBe(false);
    expect(denied.has("WebFetch")).toBe(true);
  });
});

describe("настройки с диска не читаются", () => {
  test("оба вызова query получают settingSources", () => {
    // «When omitted, all sources are loaded» — то есть без этого поля в контекст
    // каждой роли на каждом ходу подмешивался CLAUDE.md, а файл настроек рядом
    // с деплоем мог расширить права мимо DISALLOWED.
    const calls = [...RUNTIME.matchAll(/settingSources: SETTING_SOURCES/g)];
    expect(calls).toHaveLength(2);
    expect(RUNTIME).toMatch(/const SETTING_SOURCES: never\[\] = \[\];/);
  });

  test("ни один источник не включён обратно", () => {
    expect(RUNTIME).not.toMatch(/SETTING_SOURCES[^=]*=\s*\[\s*"/);
  });
});
