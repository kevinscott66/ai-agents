/**
 * Аудит 2026-08-12: «ход без тулзов» на SDK-пути всё равно приходил с
 * WebSearch/WebFetch.
 *
 * C7 (анти-дубль) в orchestrator/message-handler.ts отключает инструменты
 * на ход явным пустым списком:
 *
 *   ...(allowTools ? {} : { allowedTools: [] as string[] }),
 *   ...
 *   if (!allowTools) log.info(`[anti-dup][${def.key}] tools disabled for this turn`);
 *
 * В комментарии там сказано «Lead отвечает только текстом, без tool'ов», в
 * логе — «tools disabled for this turn». На raw-пути так и есть: tool-loop.ts
 * при пустом списке отдаёт `undefined` вместо `req.tools`, и добавление
 * web_search (`if (ws && req.tools)`) не срабатывает — нечего дополнять.
 *
 * На SDK-пути (а на проде USE_AGENT_SDK=true) строка была такая:
 *
 *   const allowed = [...toolNames.map((n) => `mcp__team__${n}`), ...WEB_TOOLS];
 *
 * buildTeamMcp честно отдавал пустой toolNames, а WEB_TOOLS приклеивался
 * безусловно. То есть ход, который по замыслу «только текст», получал два
 * сетевых инструмента: лишние ходы модели, лишние токены и внешние запросы там,
 * где вызывающий код считает, что инструментов нет вовсе.
 *
 * Сосед по файлу — runTextViaAgentSdk (:523) — пустой список передаёт без
 * WEB_TOOLS, то есть внутри одного модуля правило уже жило в двух версиях.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { sdkAllowedTools } from "../lib/agent-sdk-runtime.ts";

// Этот файл про правило C7 («явный пустой список выключает всё»), а не про
// выключатель ресёрча, который добавлен аудитом 2026-08-21. Чтобы проверять
// именно C7, держим ресёрч включённым — иначе веба не будет по другой причине.
const SAVED_WEB = process.env.WEB_SEARCH_ENABLED;
beforeEach(() => {
  process.env.WEB_SEARCH_ENABLED = "true";
});
afterAll(() => {
  if (SAVED_WEB === undefined) delete process.env.WEB_SEARCH_ENABLED;
  else process.env.WEB_SEARCH_ENABLED = SAVED_WEB;
});

describe("sdkAllowedTools", () => {
  test("явный пустой список — никаких инструментов, включая веб", () => {
    expect(sdkAllowedTools([], [])).toEqual([]);
  });

  test("список не задан — обычный набор плюс веб", () => {
    const out = sdkAllowedTools(["SEND_MESSAGE"], undefined);
    expect(out).toContain("mcp__team__SEND_MESSAGE");
    expect(out).toContain("WebSearch");
    expect(out).toContain("mcp__team__WebFetch");
    expect(out).not.toContain("WebFetch");
  });

  test("список задан и непустой — веб остаётся", () => {
    // Сужение набора роли — это не «выключить инструменты»: ресёрч остаётся
    // легальным. Отключает только явный пустой список.
    const out = sdkAllowedTools(["SEND_MESSAGE"], ["SEND_MESSAGE"]);
    expect(out).toContain("mcp__team__SEND_MESSAGE");
    expect(out).toContain("WebSearch");
    expect(out).toContain("mcp__team__WebFetch");
  });

  test("пустой набор из-за фильтра по роли — веб НЕ отключаем", () => {
    // Отдельный случай: вызывающий разрешил инструменты, но ни один из них не
    // открыт этой роли (isToolExposedToRole). Это не «ход без тулзов», и
    // отбирать ресёрч тут не за что.
    expect(sdkAllowedTools([], ["SEND_MESSAGE"])).toEqual([
      "WebSearch",
      "mcp__team__WebFetch",
    ]);
  });
});
