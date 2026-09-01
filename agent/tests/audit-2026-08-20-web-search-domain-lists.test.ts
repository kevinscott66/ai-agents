// Аудит 2026-08-20: `WEB_SEARCH_BLOCKED_DOMAINS` молча выбрасывался, если рядом
// стоял `WEB_SEARCH_ALLOWED_DOMAINS`.
//
// У Anthropic `allowed_domains` и `blocked_domains` взаимоисключающие, и код
// это учитывал — `else if`. Но интерес оператора при этом терялся целиком: он
// заводил блок-лист, тот не доезжал до API, и ни одной строки в логе об этом не
// было. Опасен ровно перекрывающийся случай: домен внесли в блок-лист, а из
// алоу-листа убрать забыли — поиск по нему продолжался. То же самое для
// поддомена: блок `coindesk.com` не снимал `www.coindesk.com` из алоу-листа.
import { test, expect, describe, afterEach } from "bun:test";
import { webSearchTool, _resetWebSearchWarnState } from "../lib/web-search.ts";
import { log } from "../lib/log.ts";

const KEYS = [
  "WEB_SEARCH_ENABLED",
  "WEB_SEARCH_MAX_USES",
  "WEB_SEARCH_ALLOWED_DOMAINS",
  "WEB_SEARCH_BLOCKED_DOMAINS",
] as const;
const saved = new Map<string, string | undefined>();
function set(k: string, v: string | undefined) {
  if (!saved.has(k)) saved.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const k of KEYS) {
    const was = saved.get(k);
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
  saved.clear();
});

function enable() {
  set("WEB_SEARCH_ENABLED", "true");
  set("WEB_SEARCH_MAX_USES", undefined);
}

describe("аудит 2026-08-20: блок-лист web_search не должен пропадать при алоу-листе", () => {
  test("якорь: один блок-лист доезжает как blocked_domains", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", undefined);
    set("WEB_SEARCH_BLOCKED_DOMAINS", "evil.example, scam.tld");
    const t = webSearchTool()!;
    expect(t.blocked_domains).toEqual(["evil.example", "scam.tld"]);
    expect(t.allowed_domains).toBeUndefined();
  });

  test("якорь: один алоу-лист доезжает как allowed_domains", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space, coindesk.com");
    set("WEB_SEARCH_BLOCKED_DOMAINS", undefined);
    const t = webSearchTool()!;
    expect(t.allowed_domains).toEqual(["delabs.space", "coindesk.com"]);
    expect(t.blocked_domains).toBeUndefined();
  });

  test("непересекающиеся списки: алоу-лист идёт как есть (поведение не менялось)", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space, coindesk.com");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "evil.example");
    const t = webSearchTool()!;
    expect(t.allowed_domains).toEqual(["delabs.space", "coindesk.com"]);
    expect(t.blocked_domains).toBeUndefined();
  });

  test("домен в обоих списках выпадает из алоу-листа", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space, coindesk.com, theblock.co");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "coindesk.com");
    const t = webSearchTool()!;
    expect(t.allowed_domains).toEqual(["delabs.space", "theblock.co"]);
    expect(t.blocked_domains).toBeUndefined();
  });

  test("блок родительского домена снимает и его поддомены", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "www.coindesk.com, api.coindesk.com, delabs.space");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "coindesk.com");
    expect(webSearchTool()!.allowed_domains).toEqual(["delabs.space"]);
  });

  test("не наоборот: блок поддомена не снимает родителя", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "coindesk.com, delabs.space");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "bad.coindesk.com");
    expect(webSearchTool()!.allowed_domains).toEqual(["coindesk.com", "delabs.space"]);
  });

  test("совпадение доменов регистронезависимо и терпит ведущую точку", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "CoinDesk.COM, delabs.space");
    set("WEB_SEARCH_BLOCKED_DOMAINS", ".coindesk.com");
    expect(webSearchTool()!.allowed_domains).toEqual(["delabs.space"]);
  });

  test("блок-лист съел весь алоу-лист → инструмент выключен, а не открыт настежь", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "coindesk.com");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "coindesk.com");
    // Ключевой момент: НЕ null-safe `allowed_domains: []` и не «оба списка
    // выкинуть». Пустой алоу-лист у Anthropic — это либо ошибка запроса, либо
    // поиск без ограничений; и то и другое хуже выключенного поиска.
    expect(webSearchTool()).toBe(null);
  });

  test("выключенный поиск остаётся выключенным независимо от списков", () => {
    set("WEB_SEARCH_ENABLED", undefined);
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "coindesk.com");
    expect(webSearchTool()).toBe(null);
  });

  test("предупреждение пишется один раз на конфиг, а не на каждый ход", () => {
    // `webSearchTool()` зовётся из tool-loop на КАЖДЫЙ запрос к модели. Без
    // дедупликации это сообщение утопило бы лог и само себя.
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space, coindesk.com");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "coindesk.com");
    _resetWebSearchWarnState();
    const orig = log.warn;
    let calls = 0;
    (log as unknown as { warn: unknown }).warn = () => {
      calls++;
    };
    try {
      webSearchTool();
      webSearchTool();
      webSearchTool();
      expect(calls).toBe(1);
      // Другой конфиг — другое предупреждение, глушить его нельзя.
      set("WEB_SEARCH_BLOCKED_DOMAINS", "delabs.space");
      webSearchTool();
      expect(calls).toBe(2);
    } finally {
      (log as unknown as { warn: unknown }).warn = orig;
      _resetWebSearchWarnState();
    }
  });

  test("пересечение не трогает max_uses", () => {
    enable();
    set("WEB_SEARCH_MAX_USES", "7");
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space, coindesk.com");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "coindesk.com");
    expect(webSearchTool()!.max_uses).toBe(7);
  });
});
