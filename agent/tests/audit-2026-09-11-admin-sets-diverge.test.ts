/**
 * Аудит 2026-09-11: «разбор теперь общий» читалось как «список общий».
 *
 * После правки 2026-08-12 обе стороны разбирают CSV одним `parseUserIdList`, и
 * докблок `parseAdminUserIds` это фиксировал. Но общей стала форма, а не
 * состав: Lead-бот предпочитает TELEGRAM_ADMIN_USER_IDS, Mini App читает
 * ТОЛЬКО MINIAPP_ADMIN_USER_IDS. Пока первая переменная пуста, наборы
 * совпадают по фолбэку; стоит её заполнить — расходятся, и ничто об этом не
 * сообщает.
 *
 * Расхождение само по себе законно: админ бота и админ Mini App совпадать не
 * обязаны. Ненаблюдаемым его делал текст — потому здесь пинится поведение
 * обеих сторон, а не формулировка.
 *
 * Почему не «починить» фолбэком в обратную сторону: это раздало бы админов
 * Telegram-бота веб-входу, включая POST /api/mac/stop. Расширять набор
 * админов ради стройности описания — ровно тот обмен, которого делать нельзя.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAdminUserIds } from "../lib/admin-commands.ts";
import { parseAllowedIds } from "../lib/miniapp-server.ts";

const TG = "TELEGRAM_ADMIN_USER_IDS";
const MA = "MINIAPP_ADMIN_USER_IDS";
const saved = { tg: process.env[TG], ma: process.env[MA] };

/** Восстанавливаем ровно исходное значение, включая «переменной не было». */
const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  restore(TG, saved.tg);
  restore(MA, saved.ma);
});

/** То, что реально читает Mini App: одна переменная, без фолбэка. */
const miniappAdmins = () => parseAllowedIds(process.env[MA]);

describe("наборы админов", () => {
  test("пустая TELEGRAM_… — наборы совпадают по фолбэку", () => {
    process.env[TG] = "";
    process.env[MA] = "111,222";
    expect(parseAdminUserIds()).toEqual([111, 222]);
    expect(miniappAdmins()).toEqual([111, 222]);
  });

  test("отсутствующая TELEGRAM_… — то же самое", () => {
    delete process.env[TG];
    process.env[MA] = "111";
    expect(parseAdminUserIds()).toEqual([111]);
    expect(miniappAdmins()).toEqual([111]);
  });

  test("непустая TELEGRAM_… разводит наборы, и в обе стороны", () => {
    process.env[TG] = "333";
    process.env[MA] = "111,222";
    // Админ Lead-бота, которого нет в Mini App.
    expect(parseAdminUserIds()).toEqual([333]);
    expect(miniappAdmins()).not.toContain(333);
    // И наоборот: 111 админ в Mini App, но не в боте.
    expect(miniappAdmins()).toContain(111);
    expect(parseAdminUserIds()).not.toContain(111);
  });

  test("фолбэка из TELEGRAM_… в Mini App нет — иначе веб-вход расширится", () => {
    process.env[TG] = "333";
    delete process.env[MA];
    expect(parseAdminUserIds()).toEqual([333]);
    expect(miniappAdmins()).toEqual([]);
  });

  test("разбор при этом действительно один и тот же", () => {
    // Ровно правка 2026-08-12: префиксный parseInt отброшен обеими сторонами.
    process.env[TG] = "12345x678, 999 ,0,-5";
    process.env[MA] = "12345x678, 999 ,0,-5";
    expect(parseAdminUserIds()).toEqual([999]);
    expect(miniappAdmins()).toEqual([999]);
  });
});

describe("расхождение названо там, где его прочтут", () => {
  test("докблок parseAdminUserIds говорит про состав, а не только про форму", () => {
    const s = readFileSync(
      new URL("../lib/admin-commands.ts", import.meta.url).pathname,
      "utf8",
    );
    const doc = s.slice(0, s.indexOf("export function parseAdminUserIds"));
    expect(doc).toContain("MINIAPP_ADMIN_USER_IDS");
    expect(doc).toContain("фолбэка в");
  });
});
