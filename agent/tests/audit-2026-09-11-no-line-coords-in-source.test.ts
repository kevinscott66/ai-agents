/**
 * Аудит 2026-09-11: координата строки в комментарии боевого кода запрещена —
 * в обеих записях, во всех боевых деревьях.
 *
 * ИЗМЕРЕНИЕ, с которого всё началось. По дереву: 157 ссылок вида
 * `file.ts:<номер>` в 103 файлах, из них 69 указывали не на тот код, который
 * называет комментарий; в `lib/` — 37 ссылок в 19 файлах. Разброс промаха от
 * одной строки до пятидесяти восьми: одна обещала ручку Mini App про автономию,
 * а показывала на неродственный обработчик списка задач; другая обещала место,
 * где ошибка пишется в БД без обрезки, а показывала на поле интерфейса. Две
 * были неверны ещё в день, когда их написали.
 *
 * ПРАВИЛО ПРОЕКТА (круг 20): когда координата протухает, НЕ подгонять номер, а
 * убрать номер и назвать символ. Имя функции переживает правку файла, номер —
 * нет.
 *
 * ПОЧЕМУ ОДИН ФАЙЛ, А НЕ ДВА. Сторожей было два, и оба били мимо:
 *
 *  • `audit-2026-09-11-stale-line-coordinates` проверяет, что строка по
 *    координате не пуста, и честно пишет в докстроке: «Проверить "координата
 *    указывает на то, что имел в виду автор" машина не может». Цена честности —
 *    четыре ссылки, у него зелёные и протухшие все четыре: отказ «admin only»
 *    вёл в рассылку событий SSE, `REQUEST_REVIEW` — в абзац про префикс
 *    `dispatch/audit failed:`, шина `action.executed` — внутрь объявления типа,
 *    а обещанный текст «в снапшоте нет таблиц» — в середину чужого докблока.
 *  • `audit-2026-09-11-lib-line-citations` (снят этим файлом) запрещал обе
 *    записи, но только в `lib/`, а голую ловил шаблоном `(:\d|, :\d` — двумя
 *    записями пунктуации вместо формы. Живой экземпляр в том же `lib/` отделял
 *    от него один пробел: `(см. :269-279)` в cold-storage.ts. Шапка этого
 *    сторожа вдобавок обещала, что «в tools/, miniapp/, orchestrator/,
 *    mac-daemon/ цитаты на строки ещё есть» — после круга 37 их там нет ни
 *    одной, то есть сторож стал описывать дерево неверно в обе стороны.
 *
 * Копия правила, действующая на части мест, — это правило, не действующее в
 * остальных. Поэтому правило здесь одно и деревья перечислены один раз.
 *
 * ГОЛАЯ ФОРМА (`(:173)`, `, :428`, `см. :269`) хуже именованной: по ней не
 * видно даже, в каком файле искать. Ловим её только в комментариях и только
 * вне бэктиков — внутри бэктиков живут цитаты кода и логов, где `:` перед
 * цифрой законен (`{"message_id":42}`, `backend on :87878`), и там же
 * комментарий цитирует саму запрещённую форму, объясняя, почему её убрали.
 * Тот же приём, что в audit-2026-08-27: цитата исправленного не должна ломать
 * проверку.
 *
 * ЧТО ЭТОТ СТОРОЖ НЕ ПОКРЫВАЕТ И ПОКРЫВАТЬ НЕ ДОЛЖЕН:
 *
 *  • `tests/**`. Там координат больше сотни, они цитируют место дефекта в
 *    разборе аудита, и массовая правка их ради зелёного цвета — подгонка, а не
 *    починка. За ними следит прежний сторож «указывает хоть на что-то».
 *  • Ссылки в зависимости (`client.js:791`, `TelegramClient.js:1088-1093`):
 *    версия пакета закреплена в lock-файле, номер не едет от наших правок,
 *    символ там не наш, и рядом с каждым уже названо имя. Под запрет не
 *    попадают — расширения ищутся только у наших файлов.
 *  • Существование названного символа. Имя ломается переименованием, а не
 *    вставкой выше по файлу, и ловится обычным grep-сторожем — четыре таких
 *    проверки стоят ниже, по одной на каждый исправленный комментарий.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Только боевые деревья: tests/** намеренно вне проверки, см. докстроку. */
const SOURCE_ROOTS = ["lib", "miniapp/src", "tools", "orchestrator", "mac-daemon"];

/** Именованная форма. Расширения — те же, что у прежнего сторожа координат. */
const NAMED = /([A-Za-z0-9_./-]+\.(?:tsx?|sh|service|timer|md|example|ya?ml|sql)):(\d+)/;

/** Голая форма: двоеточие с цифрой после пробела или открывающей скобки. */
const BARE = /(^|[\s(]):\d/;

/** Только комментарии: в коде такая строка — обычно фикстура или JSON. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/** Бэктики — цитата кода или лога; форма внутри них не наша, см. докстроку. */
const stripTicks = (line: string) => line.replace(/`[^`]*`/g, "``");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === "fixtures" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const FILES = SOURCE_ROOTS.flatMap((r) => walk(r));

/** Все строки боевых деревьев с их адресом — обходим дерево один раз. */
const LINES: Array<{ at: string; line: string }> = FILES.flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .map((line, i) => ({ at: `${f}:${i + 1}`, line })),
);

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");

describe("в боевом коде координат строк не осталось", () => {
  test("проверка смотрит на живое дерево, а не в пустоту", () => {
    // Если обход сломается и вернёт пусто, проверки ниже пройдут вхолостую.
    expect(FILES.length).toBeGreaterThan(100);
    expect(LINES.length).toBeGreaterThan(20_000);
  });

  test("ни одной ссылки вида file.ts:<строка>", () => {
    const bad = LINES.filter(({ line }) => NAMED.test(line)).map(
      ({ at, line }) => `${at}: ${line.trim()}`,
    );
    // Починка — назвать символ, а НЕ подогнать номер (правило круга 20).
    expect(bad).toEqual([]);
  });

  test("ни одной голой координаты вида (:173), , :428 или (см. :269)", () => {
    const bad = LINES.filter(
      ({ line }) => COMMENT_LINE.test(line) && BARE.test(stripTicks(line)),
    ).map(({ at, line }) => `${at}: ${line.trim()}`);
    expect(bad).toEqual([]);
  });

  test("шаблон голой формы ловит все три записи, включая ту, что утекала", () => {
    // Прежний шаблон был `(:\d|, :\d` — третья строка проходила мимо него.
    for (const s of [" * было (:173) здесь", " * см, :428 там", " * строки (см. :269-279)"]) {
      expect(COMMENT_LINE.test(s) && BARE.test(stripTicks(s))).toBe(true);
    }
  });

  test("цитата кода в бэктиках под запрет не попадает", () => {
    for (const s of [
      ' * (`"reply_parameters":"{\\"message_id\\":42}"`), поэтому',
      " * бодрое «Mini App backend on `:87878`», nginx",
      " // здесь стояли номера `299` и `:315`, оба протухшие",
    ]) {
      expect(BARE.test(stripTicks(s))).toBe(false);
    }
  });
});

describe("четыре исправленных комментария называют существующие символы", () => {
  test("admin.ts: отказ обеих ручек идёт через requireAdmin", () => {
    expect(read("miniapp/src/lib/admin.ts")).toContain("`requireAdmin(user)`");
    const server = read("lib/miniapp-server.ts");
    expect(server).toContain("function requireAdmin(user: MiniAppUser)");
    expect(server).toContain('json({ error: "admin only" }, 403)');
  });

  test("labels.ts: awaiting_review выставляет handleRequestReview", () => {
    expect(read("miniapp/src/lib/labels.ts")).toContain("`handleRequestReview`");
    const tasks = read("lib/dispatch/tasks.ts");
    expect(tasks).toContain("export function handleRequestReview(");
    expect(tasks).toContain('updateTaskStatus(payload.taskId, "awaiting_review")');
  });

  test("Logs.tsx: action.executed шлёт emitActionEvents", () => {
    expect(read("miniapp/src/pages/Logs.tsx")).toContain("`emitActionEvents`");
    const audit = read("lib/audit.ts");
    expect(audit).toContain("export function emitActionEvents(");
    expect(audit).toContain('busEmit("action.executed"');
  });

  test("restore-from-backup.ts: verifySnapshot бросает названный текст", () => {
    expect(read("tools/restore-from-backup.ts")).toContain(
      "`verifySnapshot` в\n        // lib/backup.ts бросает «в снапшоте нет таблиц»",
    );
    const backup = read("lib/backup.ts");
    expect(backup).toContain("function verifySnapshot(");
    expect(backup).toContain('throw new Error("в снапшоте нет таблиц")');
  });

  test("cold-storage.ts: сверка названа веткой, а не номером", () => {
    const cs = read("lib/cold-storage.ts");
    expect(cs).toContain("`exportColdStorage`, в ветке `nl !== rows.length`");
    expect(cs).toContain("if (nl !== rows.length) {");
  });
});
