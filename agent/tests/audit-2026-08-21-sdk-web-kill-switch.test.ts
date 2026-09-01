/**
 * Аудит 2026-08-21: `WEB_SEARCH_ENABLED` — выключатель, который на боевом
 * пути ничего не выключает.
 *
 * Raw-путь спрашивает разрешения: `tool-loop.ts:294` берёт `webSearchTool()`,
 * а тот возвращает null, пока `WEB_SEARCH_ENABLED !== "true"` (`web-search.ts:27`).
 * Дефолт — выключено: `.env.example:123` пуст, шапка `web-search.ts` — «Off by
 * default».
 *
 * SDK-путь (на проде `USE_AGENT_SDK=true`) переменную не читал вовсе. Замер:
 *
 *   WEB_SEARCH_ENABLED=(не задан) | raw даёт web_search: false | SDK даёт: WebSearch,WebFetch
 *   WEB_SEARCH_ENABLED=true       | raw даёт web_search: true  | SDK даёт: WebSearch,WebFetch
 *
 * То есть все 12 ролей получали два сетевых инструмента при выключенном
 * ресёрче — и вдобавок клиентский `WebFetch`, которому на raw-пути аналога
 * нет вовсе (там web_search резолвится на стороне Anthropic).
 *
 * Тест держит именно ПАРИТЕТ двух путей, а не литералы: если завтра переедет
 * имя переменной, разойдётся сравнение, а не заученная строка.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { sdkAllowedTools } from "../lib/agent-sdk-runtime.ts";
import { webSearchTool } from "../lib/web-search.ts";

const SAVED = process.env.WEB_SEARCH_ENABLED;

afterEach(() => {
  if (SAVED === undefined) delete process.env.WEB_SEARCH_ENABLED;
  else process.env.WEB_SEARCH_ENABLED = SAVED;
});

/**
 * Сетевые инструменты в наборе SDK-пути.
 *
 * `WebFetch` с 2026-08-21 выдаётся не нативной тулзой CLI, а нашей
 * `mcp__team__WebFetch` (см. `sdk-web-guard.ts`: резолв и пин адреса, иначе
 * SSRF идёт мимо гейта). Для выключателя это по-прежнему сетевой инструмент,
 * поэтому фильтр смотрит на суффикс имени, а не на префикс транспорта.
 */
function webToolsOf(out: string[]): string[] {
  return out.filter((t) => /(^|__)(WebSearch|WebFetch)$/.test(t));
}

function setFlag(v: string | undefined): void {
  if (v === undefined) delete process.env.WEB_SEARCH_ENABLED;
  else process.env.WEB_SEARCH_ENABLED = v;
}

describe("веб-тулзы SDK-пути слушаются WEB_SEARCH_ENABLED", () => {
  for (const off of [undefined, "", "false", "1", "TRUE"]) {
    test(`ресёрч выключен (WEB_SEARCH_ENABLED=${off ?? "не задан"}) — сети нет`, () => {
      setFlag(off);
      expect(webToolsOf(sdkAllowedTools(["SEND_MESSAGE"], undefined))).toEqual([]);
    });
  }

  test("ресёрч включён — сеть на месте", () => {
    setFlag("true");
    const out = sdkAllowedTools(["SEND_MESSAGE"], undefined);
    expect(out).toContain("mcp__team__SEND_MESSAGE");
    expect(webToolsOf(out)).toEqual(["WebSearch", "mcp__team__WebFetch"]);
    // Нативный клиентский WebFetch не выдаётся вовсе — только гейтованный.
    expect(out).not.toContain("WebFetch");
  });

  test("наш MCP-набор от выключателя не страдает", () => {
    setFlag(undefined);
    expect(sdkAllowedTools(["SEND_MESSAGE", "READ_WIKI"], undefined)).toEqual([
      "mcp__team__SEND_MESSAGE",
      "mcp__team__READ_WIKI",
    ]);
  });

  test("паритет с raw-путём при любом значении переменной", () => {
    for (const v of [undefined, "", "false", "true", "TRUE"]) {
      setFlag(v);
      const rawHasWeb = webSearchTool() !== null;
      const sdkHasWeb = webToolsOf(sdkAllowedTools(["SEND_MESSAGE"], undefined)).length > 0;
      expect({ v, sdkHasWeb }).toEqual({ v, sdkHasWeb: rawHasWeb });
    }
  });

  test("C7 (явный пустой список) продолжает выключать всё и при включённом ресёрче", () => {
    setFlag("true");
    expect(sdkAllowedTools([], [])).toEqual([]);
  });

  test("сужение набора ролью — не повод отбирать ресёрч", () => {
    setFlag("true");
    expect(sdkAllowedTools([], ["SEND_MESSAGE"])).toEqual([
      "WebSearch",
      "mcp__team__WebFetch",
    ]);
  });
});
