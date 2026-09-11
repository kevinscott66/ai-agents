/**
 * Аудит 2026-09-11, круг 27: докблок, за которым сразу идёт второй докблок,
 * не показывается никому — и в репозитории таких набралось 27.
 *
 * `/** … *\/`, стоящий не вплотную к символу, а перед ЕЩЁ ОДНИМ `/** … *\/`,
 * теряется целиком: и tsserver, и редактор при наведении берут последний
 * блок перед объявлением, остальные — обычный текст между стейтментами.
 * Читают такое место только те, кто открыл файл и прокрутил до него; ни
 * подсказка в IDE, ни `.d.ts` первый блок не покажут.
 *
 * Заводится это само, двумя путями. Первый: между докблоком и его символом
 * вставляют новую сущность со своим докблоком — объяснение остаётся на месте,
 * а символ уезжает вниз (`sendDigest` в tools/approve-poll.ts уехала так за
 * интерфейс `DigestSendResult`; `escapeXml` и `findExternalHref` в
 * lib/svg-render.ts — так же). Второй: правку приписывают новым блоком сверху
 * вместо абзаца внутрь (`APPROVAL_SELECT` в lib/approvals.ts нёс два блока про
 * один и тот же джойн, младший скрывал старший).
 *
 * Цена — ровно та, от которой заводился круг 24: в этом репозитории
 * комментарий равноправен коду, и спрятанное объяснение перестаёт работать
 * молча. Хуже того, оба пути прячут СТАРШИЙ блок — тот, где записана причина,
 * а не последняя правка. В lib/action-payload.ts под невидимым блоком лежало
 * надгробие удалённому полю `_depth`: следующий, кто захочет «вернуть счётчик
 * глубины», прочитает его, только если сам откроет файл.
 *
 * Что делать, когда тест упал: решить, чей это докблок, и поставить его
 * вплотную к своему символу — а если оба про одно и то же, слить в один блок
 * абзацем. Удалять старший «как устаревший» нельзя: в нём обычно и лежит
 * причина, ради которой код написан так, а не иначе.
 *
 * Круг 28: пустая строка между двумя докблоками ничего не меняет — tsserver
 * так же отдаёт последний, — а первая версия проверки смотрела только на
 * соседние строки и такую пару пропускала. Нашлось трое: докблок удалённой
 * `WEB_TOOLS` в lib/agent-sdk-runtime.ts, объяснение `resolveUserbotHandle` в
 * lib/action-dispatch.ts (символ уехал за `DELEGATE_REPLY_MAX`) и заметка про
 * копию резолвинга путей в lib/memory-async.ts.
 *
 * Исключение ровно одно: шапка файла. Блок, над которым нет ни строки кода,
 * описывает модуль, а не следующий символ, и стоять вплотную к нему не обязан
 * — таких пар в дереве 13, и все они законны. Признак «нет кода выше»
 * проверяется, а не объявляется: шапка, под которой уже появился код,
 * перестанет быть исключением сама.
 *
 * Надгробия в `/* … *\/` (без второй звезды) проверка не трогает: они не
 * докблоки, tsserver их не показывает никому и заслонить не может. Так
 * записана, например, заметка об удалённой `hardSlice` в
 * lib/telegram-chunking.ts.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["lib", "orchestrator", "tests", "tools", "mac-daemon", "miniapp/src"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Открывашка докблока — с любым отступом, с хвостом текста или без. */
const OPENS = /^\s*\/\*\*/;
/** Строка, которой докблок кончается: `*\/` отдельно или `/** … *\/` целиком. */
const ENDS = /(^\s*\*\/\s*$)|(^\s*\/\*\*.*\*\/\s*$)/;
/** Открывашка без хвоста — с неё докблок начинается и ею не кончается. */
const BARE_OPENER = /^\s*\/\*\*\s*$/;
/** Начало ЛЮБОГО блочного комментария — и докблока, и надгробия `/*`. */
const BLOCK_OPENS = /^\s*\/\*/;
/** Конец блочного комментария — закрывашка где угодно на строке. */
const BLOCK_ENDS = /\*\//;

type Block = { start: number; end: number; doc: boolean };

/**
 * Блочные комментарии файла по порядку — и был ли код до каждого из них.
 *
 * «Код» здесь — строка вне комментария, которая не пуста и не `//`: по ней
 * отличается шапка модуля (кода выше нет) от объяснения, потерявшего символ.
 */
function scan(lines: string[]): { blocks: Block[]; codeBefore: boolean[] } {
  const blocks: Block[] = [];
  const codeBefore: boolean[] = [];
  let seenCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!BLOCK_OPENS.test(line)) {
      const t = line.trim();
      if (t !== "" && !t.startsWith("//")) seenCode = true;
      continue;
    }
    const start = i;
    // Однострочный `/** … *\/` закрывается на себе же; ищем закрывашку правее
    // открывашки, иначе `/**` считалось бы закрытым собственной звёздочкой.
    let end = i;
    while (end < lines.length && !BLOCK_ENDS.test(lines[end].slice(end === start ? line.indexOf("/*") + 2 : 0))) {
      end++;
    }
    if (end >= lines.length) end = lines.length - 1;
    blocks.push({ start, end, doc: OPENS.test(line) });
    codeBefore.push(seenCode);
    i = end;
  }
  return { blocks, codeBefore };
}

function orphans(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (!OPENS.test(lines[i + 1])) continue;
        if (ENDS.test(lines[i])) {
          found.push(`${file}:${i + 1} — докблок закрылся, и сразу открылся следующий`);
        } else if (BARE_OPENER.test(lines[i])) {
          found.push(`${file}:${i + 1} — две открывашки подряд`);
        }
      }
      const { blocks, codeBefore } = scan(lines);
      for (let b = 0; b + 1 < blocks.length; b++) {
        const a = blocks[b];
        const next = blocks[b + 1];
        if (!a.doc || !next.doc) continue;
        const gap = next.start - a.end - 1;
        if (gap < 1) continue; // вплотную — это уже нашла проверка выше
        if (lines.slice(a.end + 1, next.start).some((l) => l.trim() !== "")) continue;
        if (!codeBefore[b]) continue; // шапка модуля: описывает файл, а не символ ниже
        found.push(`${file}:${a.end + 1} — докблок отделён от следующего только пустой строкой`);
      }
    }
  }
  return found;
}

describe("докблок стоит вплотную к своему символу", () => {
  test("ни один докблок не заслонён следующим", () => {
    expect(orphans()).toEqual([]);
  });

  test("проверка видит все три формы, а не одну", () => {
    // Иначе «зелено» означало бы лишь то, что тест ничего не ищет.
    // Многострочный, закрытый своей `*\/`.
    expect(ENDS.test(" */") && OPENS.test("/**")).toBe(true);
    // Однострочный `/** … *\/` — заслоняет следующий так же.
    expect(ENDS.test("/** Порт Mini App. */")).toBe(true);
    expect(ENDS.test("  /** С отступом. */")).toBe(true);
    // Две открывашки подряд — вторая форма.
    expect(BARE_OPENER.test("/**") && BARE_OPENER.test("  /**")).toBe(true);
    expect(BARE_OPENER.test("/** однострочный */")).toBe(false);
    // Обычный код и обычный комментарий проверку не трогают.
    expect(OPENS.test("const x = 1;") || OPENS.test("// строка")).toBe(false);
    expect(ENDS.test("const x = 1;")).toBe(false);
  });

  test("пустая строка между докблоками — тоже находка", () => {
    const src = [
      "const a = 1;",
      "/** Старший. */",
      "",
      "/** Младший. */",
      "const b = 2;",
    ];
    const { blocks, codeBefore } = scan(src);
    expect(blocks.map((x) => [x.start, x.end, x.doc])).toEqual([
      [1, 1, true],
      [3, 3, true],
    ]);
    expect(codeBefore).toEqual([true, true]);
  });

  test("шапка файла — не находка, а надгробие `/*` — не докблок", () => {
    // Шапка: кода выше нет, к следующему символу примыкать не обязана.
    const header = scan(["/**", " * Модуль.", " */", "", "/** Первый символ. */", "const a = 1;"]);
    expect(header.codeBefore).toEqual([false, false]);
    // Надгробие: одна звезда, tsserver его никому не показывает.
    const tomb = scan(["const a = 1;", "/*", " * Здесь жила hardSlice.", " */", "", "/** Следующий. */"]);
    expect(tomb.blocks.map((x) => x.doc)).toEqual([false, true]);
  });
});
