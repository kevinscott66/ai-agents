/**
 * Аудит 2026-09-11: счётчик «(i/N) » ломал разметку первой строки части.
 *
 * `sendChunked` приклеивал его ПЕРЕД частью и ПОСЛЕ того, как
 * `splitForTelegram` уже померил и нарезал. Дальше отправитель зовёт
 * `mdToTelegramHtml` на готовой строке, а три правила конвертера привязаны к
 * началу строки флагом `m`: заголовок `^#{1,6}\s+` (шаг 7), горизонтальная
 * черта (7b) и маркер списка `^(\s*)[-*+]\s+` (8). Пробел перед решёткой
 * сдвигает их с якоря, и правило не срабатывает.
 *
 * Замер на части `"## Заголовок\n- пункт"`: без префикса уходит
 * `"<b>Заголовок</b>\n• пункт"`, с `"(2/3) "` — `"(2/3) ## Заголовок\n•
 * пункт"`. Решётки видит читатель, жирность потеряна.
 *
 * Задета ровно первая строка КАЖДОЙ части, включая первую: счётчик ставится
 * всем, как только частей больше одной. Остальные строки якорь не теряют, а
 * неразрезанный текст не задет вовсе — то есть один и тот же ответ выглядит
 * по-разному в зависимости от того, перевалил ли он за лимит.
 *
 * Тихо: HTML валиден, 400 от Telegram нет, плейн-фолбэк не взводится, в
 * аудите — успешная отправка. Попадание при этом частое, а не краевое:
 * `splitForTelegram` режет по пустым строкам, и ровно после пустой строки в
 * ответе модели чаще всего и стоит заголовок или первый пункт списка.
 *
 * Починка — отбить счётчик переводом строки. Это самый узкий из возможных
 * вариантов: менять якоря в конвертере значило бы трогать разбор всякого
 * текста ради оформления доставки, а снять счётчик нельзя — он единственное,
 * что говорит читателю, что сообщение не последнее.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sendChunked } from "../lib/telegram-chunking.ts";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "telegram-chunking.ts"), "utf8");

/** Текст, который гарантированно режется и начинает часть с заголовка. */
function twoPartsStartingWithHeading(): string {
  const filler = "я".repeat(3990);
  return `${filler}\n\n## Заголовок\n- пункт один\n- пункт два`;
}

async function collect(text: string): Promise<string[]> {
  const sent: string[] = [];
  await sendChunked(async (t) => {
    sent.push(t);
    return { message_id: sent.length };
  }, text);
  return sent;
}

describe("счётчик не съедает разметку начала строки", () => {
  test("заголовок во второй части остаётся заголовком", async () => {
    const sent = await collect(twoPartsStartingWithHeading());
    expect(sent.length).toBeGreaterThan(1);
    const second = sent[1]!;
    expect(second).toContain("(2/");
    const html = mdToTelegramHtml(second);
    expect(html).toContain("<b>Заголовок</b>");
    // Замер находки: решётки уходили читателю буквально.
    expect(html).not.toContain("## Заголовок");
  });

  test("маркер списка в начале части остаётся маркером", async () => {
    const sent = await collect(`${"я".repeat(3990)}\n\n- пункт один\n- пункт два`);
    expect(sent.length).toBeGreaterThan(1);
    const html = mdToTelegramHtml(sent[1]!);
    expect(html).toContain("• пункт один");
    expect(html).not.toContain("- пункт один");
  });

  test("горизонтальная черта в начале части по-прежнему выкидывается", async () => {
    const sent = await collect(`${"я".repeat(3990)}\n\n---\nхвост`);
    expect(sent.length).toBeGreaterThan(1);
    const html = mdToTelegramHtml(sent[1]!);
    expect(html).not.toContain("---");
    expect(html).toContain("хвост");
  });

  test("первая часть задета наравне с остальными — счётчик ставится всем", async () => {
    const sent = await collect(`## Первый\n${"я".repeat(3990)}\n\n## Второй`);
    expect(sent.length).toBeGreaterThan(1);
    expect(mdToTelegramHtml(sent[0]!)).toContain("<b>Первый</b>");
  });

  test("неразрезанный текст и раньше был цел — сравнение с ним и есть находка", () => {
    // Тот же текст без счётчика (одна часть) конвертировался правильно
    // всегда. Разницу между «влезло» и «не влезло» читатель не выбирает.
    expect(mdToTelegramHtml("## Первый")).toBe("<b>Первый</b>");
  });
});

describe("сам счётчик на месте", () => {
  test("нумерация видна и считает части, а не что-то ещё", async () => {
    const sent = await collect(twoPartsStartingWithHeading());
    const n = sent.length;
    sent.forEach((part, i) => expect(part.startsWith(`(${i + 1}/${n})\n`)).toBe(true));
  });

  test("одна часть уходит без счётчика вовсе", async () => {
    const sent = await collect("коротко");
    expect(sent).toEqual(["коротко"]);
  });

  test("счётчик занимает отдельную строку, а не приклеен пробелом", () => {
    expect(SRC).toContain("`(${i + 1}/${parts.length})\\n`");
    expect(SRC).not.toContain("`(${i + 1}/${parts.length}) `");
  });
});

describe("форма счётчика нигде не задублирована пробелом", () => {
  // Пробельная форма была записана не только у производителя: три сторожа в
  // других файлах проверяли её своими регулярками и упали на правке. Это и
  // есть копия правила — она действует ровно до тех пор, пока кто-нибудь не
  // забудет один из экземпляров. Сторож ниже держит форму одну на всех: ни в
  // одном исходнике не должно быть регулярки, требующей пробел после номера.
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  test("ни один исходник не ждёт пробела после номера части", () => {
    const root = join(import.meta.dir, "..");
    const offenders = ["lib", "tools", "tests"]
      .flatMap((d) => sources(join(root, d)))
      .filter((f) => readFileSync(f, "utf8").includes("\\d+\\) "))
      .map((f) => f.slice(root.length));
    expect(offenders).toEqual([]);
  });
});

describe("предпосылка: якоря конвертера действительно строчные", () => {
  test("пробел перед решёткой отменяет заголовок — ради этого и правка", () => {
    // Если это когда-нибудь перестанет быть правдой, отбивка переводом строки
    // станет лишней, и узнать об этом надо здесь, а не по виду канала.
    expect(mdToTelegramHtml("## Заголовок")).toBe("<b>Заголовок</b>");
    expect(mdToTelegramHtml("x ## Заголовок")).toBe("x ## Заголовок");
  });

  test("перевод строки якорь возвращает", () => {
    expect(mdToTelegramHtml("(2/3)\n## Заголовок")).toBe("(2/3)\n<b>Заголовок</b>");
  });
});
