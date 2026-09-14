/**
 * Аудит 2026-09-11, круг 51, второй ярус: комментарии, которые не уводят
 * читателя в неверное решение, но называют число — и число уже не то.
 *
 * Первый ярус (tests/audit-2026-09-11-lying-comments-tier1.test.ts) собрал
 * враньё, меняющее поведение читателя. Здесь — враньё-счёт: «получает
 * одиннадцать полей», «три отказа ДО него», «часть из 75 вызовов». Цена ниже,
 * но класс тот же: счёт, записанный прозой, живёт ровно до следующей правки
 * кода, а правят код и прозу разные руки.
 *
 * Лечение — по правилу круга 20: не подгонять число, а убрать его и назвать
 * символ, по которому считают. Тесты ниже поэтому требуют двух вещей сразу:
 *  1) в активной прозе числа больше нет;
 *  2) настоящий счёт измерен кодом — чтобы было видно, НАСКОЛЬКО разъехалось,
 *     и чтобы надгробие в постмортеме не превратилось в новое враньё.
 *
 * Надгробия (старые числа, названные прошедшим временем внутри разбора)
 * законны и проверяются отдельно: их наличие — доказательство, что правку
 * сделали разбором, а не затиранием.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
/** Докблоки несут ` * ` в каждой строке — сплющиваем, иначе не найти фразу. */
function flat(s: string): string {
  return s.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
}

const COMMANDS = src("lib/commands.ts");
const DISPATCH = src("lib/action-dispatch.ts");
const ERRORS = src("lib/errors.ts");

describe("lib/commands.ts не считает поля и отказы прозой", () => {
  test("DispatchCtx на сегодня заметно шире одиннадцати полей", () => {
    // Замер, а не вера: берём тело интерфейса и считаем поля верхнего уровня.
    const at = DISPATCH.indexOf("export interface DispatchCtx");
    expect(at).toBeGreaterThan(0);
    const open = DISPATCH.indexOf("{", at);
    // Границы тела — по балансу скобок: внутри есть вложенные типы функций.
    let depth = 0;
    let end = open;
    for (let i = open; i < DISPATCH.length; i++) {
      if (DISPATCH[i] === "{") depth++;
      else if (DISPATCH[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = DISPATCH.slice(open + 1, end);
    const fields = new Set(
      body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
        .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(l)?.[1])
        .filter((n): n is string => Boolean(n)),
    );
    // Число не закрепляем точно — закрепляем то, что прежняя проза устарела.
    expect(fields.size).toBeGreaterThan(11);
    expect(fields.has("agentKey")).toBe(true);
    expect(fields.has("handoffBudget")).toBe(true);
  });

  test("докблок ApprovalExecDeps называет тип, а не количество полей", () => {
    const at = COMMANDS.indexOf("export type ApprovalExecDeps");
    expect(at).toBeGreaterThan(0);
    const doc = flat(COMMANDS.slice(COMMANDS.lastIndexOf("/**", at), at));
    expect(doc).toContain("получает весь `DispatchCtx`");
    // Число уцелело только в разборе — и названо прошедшим временем.
    expect(doc.indexOf("Числа здесь нет намеренно")).toBeLessThan(
      doc.indexOf("полей было одиннадцать"),
    );
  });

  test("failBeforeDispatch зовут больше трёх раз", () => {
    const lines = COMMANDS.split("\n");
    const calls = lines.filter(
      (l) => l.includes("failBeforeDispatch(") && !l.includes("function failBeforeDispatch"),
    );
    expect(calls.length).toBeGreaterThan(3);
  });

  test("комментарий о закрытии строки действия числа не называет", () => {
    const at = COMMANDS.indexOf("Строку действия закрыл тот, кто отказал");
    expect(at).toBeGreaterThan(0);
    const note = flat(COMMANDS.slice(at, at + 700)).replace(/\/\//g, "");
    expect(note).not.toContain("а три отказа ДО него");
    expect(note).toContain("а отказы ДО него — `failBeforeDispatch`");
    // Пояснение, почему числа нет, стоит рядом — иначе его допишут обратно.
    expect(note).toContain("Числа отказов тут не называем");
  });
});

describe("lib/errors.ts не считает вызовы прозой", () => {
  test("вызовов getErrorMessage сильно больше семидесяти пяти", () => {
    let total = 0;
    const roots = ["lib", "tools", "dispatch", "tests"];
    const walk = (dir: string): void => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (!line.includes("getErrorMessage(")) continue;
          if (/import .*getErrorMessage|export function getErrorMessage/.test(line)) continue;
          total++;
        }
      }
    };
    const base = new URL("../", import.meta.url).pathname;
    for (const r of roots) walk(`${base}${r}`);
    expect(total).toBeGreaterThan(75);
  });

  test("шапка getErrorMessage перестала называть 75", () => {
    const at = ERRORS.indexOf("export function getErrorMessage");
    const doc = flat(ERRORS.slice(ERRORS.lastIndexOf("/**", at), at));
    expect(doc).toContain("Часть вызовов оборачивает Bot API");
    expect(doc).toContain("Чистим здесь, а не по вызывающим");
    // Старые формулировки — только внутри разбора круга 51.
    expect(doc.indexOf("круг 51")).toBeLessThan(doc.indexOf("часть из 75"));
    expect(doc).not.toContain("Часть из 75 вызовов");
    expect(doc).not.toContain("не в 75 местах: точка");
  });
});
