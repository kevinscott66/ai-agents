/**
 * Аудит 2026-08-28: три мелочи в логах хендлера сообщений.
 *
 * 1. `[ingest-rate]` печатал СЫРОЙ `ctx.from?.id` на уровне warn, то есть в
 *    journalctl на проде. Соседний докблок про строку `[raw]` этот случай
 *    прямо запрещает, и обе строки рядом ([raw] и [in]) правило соблюдают —
 *    выпала ровно одна.
 *
 * 2. `redactUserId(ctx.from?.id ?? ctx.from?.username)` — антипаттерн, уже
 *    разобранный аудитом 2026-08-27 в userbot-ingest и закрытый там
 *    `redactSender`. Примитив спроектирован под числовой id: имя он режет как
 *    идентификатор, `redactUserId("ivanov")` даёт `uid:anov`, и читающий лог
 *    будет считать разных людей одним отправителем. На Bot API ветка почти
 *    мёртвая (User.id обязателен), но расхождение двух одинаковых мест хуже
 *    самого дефекта.
 *
 * 3. Список ступеней в шапке файла расходился с кодом: запись в короткую
 *    память названа ПОСЛЕ маршрутизации и дедупа, хотя идёт до обеих, а
 *    стоп-гейт и ingest rate-limit не названы вовсе.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { redactSender, redactUserId } from "../lib/log.ts";

const SRC = readFileSync(
  new URL("../orchestrator/message-handler.ts", import.meta.url),
  "utf8",
);

// Комментарии снимаем построчно, а не регуляркой по `/*…*/`: в файле есть
// строковые литералы со звёздочками, и блочная регулярка съедала полфайла
// вместе с проверяемыми строками (тихо, оставляя тест зелёным ни на чём).
function codeLines(): string[] {
  return SRC.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

describe("предпосылки", () => {
  test("redactUserId на имени публикует его хвост, а не редактирует", () => {
    expect(redactUserId("ivanov")).toBe("uid:anov");
    expect(redactSender(undefined, "ivanov")).not.toBe("uid:anov");
    expect(redactSender(undefined, "ivanov")).toContain("name:");
  });

  test("при живом id redactSender ведёт себя как прежде", () => {
    expect(redactSender(123456789, "ivanov")).toBe(redactUserId(123456789));
  });
});

describe("логи хендлера", () => {
  test("ни одна строка лога не печатает сырой ctx.from", () => {
    const hits: string[] = [];
    for (const l of codeLines()) {
      if (!/^\s*`?\[|log\.(info|warn|error)/.test(l) && !l.includes("${ctx.from")) continue;
      if (/\$\{ctx\.from\??\.(id|username|first_name)\}/.test(l)) hits.push(l.trim());
    }
    expect(hits).toEqual([]);
  });

  test("отправитель редактируется парным примитивом, а не `id ?? username`", () => {
    const hits: string[] = [];
    for (const l of codeLines()) {
      if (/redactUserId\([^)]*\?\?/.test(l)) hits.push(l.trim());
    }
    expect(hits).toEqual([]);
    expect(SRC).toContain("redactSender(ctx.from?.id, ctx.from?.username)");
  });

  test("обе строки апдейта — [raw] и [in] — режут одинаково", () => {
    const uses = codeLines().filter((l) => l.includes("redactSender(ctx.from"));
    expect(uses.length).toBe(2);
    expect(uses.some((l) => l.includes("[raw]"))).toBe(true);
    expect(uses.some((l) => l.includes("[in]"))).toBe(true);
  });
});

describe("шапка файла описывает настоящий порядок", () => {
  const header = SRC.slice(0, SRC.indexOf("*/"));

  test("названы ступени, которых в прежнем списке не было", () => {
    expect(header).toContain("стоп-гейт");
    expect(header).toContain("rate-limit");
    expect(header).toContain("вложен");
  });

  test("запись в память названа до маршрутизации, как в коде", () => {
    const mem = header.indexOf("короткую память");
    const route = header.indexOf("маршрутизация");
    expect(mem).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(mem);

    // И это действительно так по коду: recordMessage раньше, чем shouldReply.
    const lines = codeLines();
    const iMem = lines.findIndex((l) => l.includes("recordMessage({"));
    const iRoute = lines.findIndex((l) => l.includes("let shouldReply = false;"));
    expect(iMem).toBeGreaterThan(0);
    expect(iRoute).toBeGreaterThan(iMem);
  });

  test("стоп-гейт в коде стоит до дедупа и до лимита, как обещано", () => {
    const lines = codeLines();
    const iStop = lines.findIndex((l) => l.includes("agentStopReason(def.key)"));
    const iDedup = lines.findIndex((l) => l.includes("shouldProcessTrigger("));
    const iRate = lines.findIndex((l) => l.includes("checkAndConsumeIngestLimit("));
    expect(iStop).toBeGreaterThan(0);
    expect(iDedup).toBeGreaterThan(iStop);
    expect(iRate).toBeGreaterThan(iDedup);
  });
});
