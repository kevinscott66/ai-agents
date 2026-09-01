// Аудит 2026-08-29: настройки поиска молча превращались в свою
// противоположность.
//
// Два фейл-опена в одном файле, и оба выглядят как рабочий конфиг:
//
//  1. `WEB_SEARCH_ALLOWED_DOMAINS=","` (запятая, пробелы, остаток после правки)
//     разбирался в ноль доменов, а `csv()` возвращал на это undefined — ровно
//     то же, что и на «переменная не задана». Политика исчезала целиком: поиск
//     уходил по всему вебу, WebFetch переставал считаться ограниченным, а на
//     SDK-пути (прод — `USE_AGENT_SDK=true`) обратно включался нативный
//     WebSearch, который домены не умеет в принципе.
//  2. `WEB_SEARCH_MAX_USES=0` давало 3. Оператор писал «поиска нет» и получал
//     поиск.
//
// В обоих случаях интерфейс отвечает «принято», а делает противоположное — и
// узнать об этом можно только по счёту. Ответ здесь тот же, что уже был выбран
// для схлопнувшегося после вычитания алоу-листа: конфиг сломан, чинить его
// должен человек, а до тех пор поиск закрыт.
import { test, expect, describe, afterEach } from "bun:test";
import {
  webSearchTool,
  webFetchAllowlistConfigured,
  webFetchDomainPolicyReason,
  sdkNativeWebSearchAllowed,
  makeSdkWebSearchLimiter,
  _resetWebSearchWarnState,
} from "../lib/web-search.ts";

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
  _resetWebSearchWarnState();
});

function enable() {
  set("WEB_SEARCH_ENABLED", "true");
  set("WEB_SEARCH_MAX_USES", undefined);
  set("WEB_SEARCH_ALLOWED_DOMAINS", undefined);
  set("WEB_SEARCH_BLOCKED_DOMAINS", undefined);
  _resetWebSearchWarnState();
}

// Граница проводится по тому, писал ли оператор список вообще. Значение без
// единого непробельного символа («» из `VAR=` в .env, « » из кавычек в шелле)
// — это «не задано»: сказать по нему нечего. А вот разделители без доменов
// («,», «, ,», «,,,») показывают, что список писали и он развалился — вот эти
// и должны закрывать поиск, а не отменять политику.
const EMPTY_FORMS = [",", " , ", ",,,", ", ,"];

describe("заданный, но пустой список доменов не отменяет политику", () => {
  test("якорь: незаданные списки поиск не трогают", () => {
    enable();
    const t = webSearchTool();
    expect(t).not.toBeNull();
    expect(t!.allowed_domains).toBeUndefined();
    expect(t!.blocked_domains).toBeUndefined();
    expect(webFetchAllowlistConfigured()).toBe(false);
    expect(webFetchDomainPolicyReason("coindesk.com")).toBeNull();
    expect(sdkNativeWebSearchAllowed()).toBe(true);
  });

  for (const form of EMPTY_FORMS) {
    test(`алоу-лист ${JSON.stringify(form)} выключает поиск, а не снимает ограничение`, () => {
      enable();
      set("WEB_SEARCH_ALLOWED_DOMAINS", form);
      expect(webSearchTool()).toBeNull();
    });
  }

  test("значение из одних пробелов читается как незаданное", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "   ");
    // Отличить « » от «» нельзя ни по смыслу, ни по происхождению — обе формы
    // значат «оператор ничего не написал». Ломать на них поиск было бы
    // сюрпризом без причины.
    expect(webSearchTool()).not.toBeNull();
    expect(webFetchAllowlistConfigured()).toBe(false);
    expect(sdkNativeWebSearchAllowed()).toBe(true);
  });

  test("пустой блок-лист закрывает поиск так же", () => {
    enable();
    set("WEB_SEARCH_BLOCKED_DOMAINS", " , ");
    expect(webSearchTool()).toBeNull();
  });

  test("WebFetch продолжает считать себя ограниченным", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", ",");
    // Иначе опечатка в переменной делала бы загрузку страниц свободной ровно
    // там, где оператор её сузил.
    expect(webFetchAllowlistConfigured()).toBe(true);
    expect(webFetchDomainPolicyReason("coindesk.com")).toContain("задан, но пуст");
    expect(webFetchDomainPolicyReason("delabs.space")).toContain("задан, но пуст");
  });

  test("нативный SDK-поиск не включается обратно", () => {
    enable();
    set("WEB_SEARCH_BLOCKED_DOMAINS", ",");
    // Самый дорогой из исходов: нативный WebSearch доменных списков не несёт
    // вовсе, так что «включился обратно» здесь значит «весь веб открыт».
    expect(sdkNativeWebSearchAllowed()).toBe(false);
  });

  test("непустой список по-прежнему доезжает до API", () => {
    enable();
    set("WEB_SEARCH_ALLOWED_DOMAINS", "delabs.space, , coindesk.com");
    const t = webSearchTool()!;
    expect(t.allowed_domains).toEqual(["delabs.space", "coindesk.com"]);
  });
});

describe("WEB_SEARCH_MAX_USES=0 значит ноль", () => {
  test("инструмент поиска не предлагается вовсе", () => {
    enable();
    set("WEB_SEARCH_MAX_USES", "0");
    expect(webSearchTool()).toBeNull();
    expect(sdkNativeWebSearchAllowed()).toBe(false);
  });

  test("ограничитель SDK отклоняет первую же попытку", () => {
    enable();
    set("WEB_SEARCH_MAX_USES", "0");
    const limit = makeSdkWebSearchLimiter();
    expect(limit("WebSearch")).toContain("исчерпан");
    // Чужие инструменты ограничитель не трогает — это не менялось.
    expect(limit("WebFetch")).toBeNull();
  });

  test("положительный потолок работает как работал", () => {
    enable();
    set("WEB_SEARCH_MAX_USES", "2");
    const t = webSearchTool()!;
    expect(t.max_uses).toBe(2);
    const limit = makeSdkWebSearchLimiter();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toContain("исчерпан");
  });

  test("мусор и отрицательные значения всё ещё дают дефолт 3", () => {
    enable();
    for (const bad of ["abc", "-1", ""]) {
      set("WEB_SEARCH_MAX_USES", bad);
      expect(webSearchTool()!.max_uses).toBe(3);
    }
  });
});
