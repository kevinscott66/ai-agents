/**
 * Аудит 2026-08-28: жёсткая резка длинной строки мерила куски чужой чётностью
 * фенсов.
 *
 * `splitForTelegram` держит `carry` — открывашку ```-блока, разорванного
 * предыдущей частью. Мерка `fits` замыкает его по ссылке и приклеивает к
 * кандидату (см. withFenceMarkers), потому что `balanceFences` допишет ровно
 * эти маркеры перед отправкой. Двигает `carry` только `push`.
 *
 * Ветка «длинная строка без переносов» звала жадный `hardSlice`, который
 * возвращал ВЕСЬ массив кусков до того, как вызывающий положит хоть один.
 * Значит правильно померен был только первый кусок: остальные мерились
 * чётностью, которой на момент их отправки уже не будет. Замер: строка из
 * markdown-ссылок, начинающаяся с ``` (лимит 4096 по видимой длине) —
 * часть в 19652 видимых символа.
 *
 * Второе, независимое: `withFenceMarkers` мерил кандидата ТОЛЬКО закрытым,
 * а комментарий обещал, что ошибка идёт в безопасную сторону. Она идёт в обе.
 * `mdToTelegramHtml` разбирает фенсы как /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/ —
 * у ЗАКРЫТОГО блока прогон после ``` съедается как lang-токен, у незакрытого
 * блока нет вовсе и тот же прогон считается обычным текстом. Последнюю часть
 * `balanceFences` намеренно не закрывает, так что расхождение реализуется
 * всегда: "```" + 8400 символов меряется как 0 и уезжает как 8403.
 *
 * Вред одинаковый: Telegram отвечает 400 «message is too long» уже посреди
 * многочастной отправки — `PartialSendError` с `sideEffect`, повтор запрещён,
 * в чате остаётся обрезанный ответ, остаток теряется. Триггер достижим из
 * недоверенного ввода, который агент цитирует дословно: вложение через
 * READ_FILE, выдача web_search, текст пользователя.
 *
 * Третье, всплывшее при починке первых двух: честная мерка обнажила, что
 * `carry` мог быть длиной с лимит. `FENCE_RE` считает языком любой прогон
 * `[a-zA-Z0-9_+-]` сразу после ```, а `balanceFences` дописывает открывашку
 * целиком в начало следующей части — то есть «язык» на 4000 символов и
 * дублировался бы в каждую часть, и не оставлял в мерке места ни под что:
 * резчик выдавал бы тысячи частей по два символа. Открывашка теперь
 * обрезается до 16 символов; для читателя это ничего не меняет, потому что
 * lang-токен форматтер выбрасывает.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitForTelegram, htmlPartFits } from "../lib/telegram-chunking.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

/** Жёсткий предел Bot API для текста сообщения. */
const HARD = 4096;
const FITS = htmlPartFits(HARD);

const link = (n: number) =>
  `[ai-agents#${n}](https://github.com/kevinscott66/ai-agents/pull/${n})`;

const manyLinks = (n: number) =>
  Array.from({ length: n }, (_, i) => link(500 + i)).join(" ");

/** Прогон из символов, которые `FENCE_RE` примет за lang-токен. */
const langRun = (n: number) => {
  const alpha = "aA0_+-";
  let s = "";
  for (let i = 0; i < n; i++) s += alpha[i % alpha.length];
  return s;
};

/**
 * `splitForTelegram` отдаёт части уже пропущенными через `balanceFences`:
 * недостающие маркеры дописаны, последняя часть намеренно оставлена
 * незакрытой. То есть возвращённая строка — ровно то, что уйдёт в Telegram,
 * и мерить её надо как есть.
 */
const measure = plainTelegramLength;

describe("предпосылки: одна и та же строка меряется по-разному", () => {
  test("закрытый блок съедает lang-токен, незакрытый — нет", () => {
    const token = langRun(8400);
    // Закрыт: весь прогон ушёл в lang, видимого текста не осталось.
    expect(plainTelegramLength("```" + token + "\n```")).toBe(0);
    // Не закрыт: блока нет, тот же прогон виден целиком.
    expect(plainTelegramLength("```" + token)).toBeGreaterThan(8400);
  });

  test("ссылка внутри блока и вне него меряются по-разному", () => {
    const bare = link(590);
    expect(plainTelegramLength(bare)).toBeLessThan(bare.length / 2);
    expect(plainTelegramLength("```\n" + bare + "\n```")).toBe(bare.length);
  });
});

describe("жёсткая резка меряет куски своей чётностью фенсов", () => {
  test("строка из ссылок после ``` не даёт частей выше предела", () => {
    // До правки: одна из частей — 19652 видимых символа при пределе 4096.
    const parts = splitForTelegram("```" + manyLinks(400), HARD, FITS);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(measure(p)).toBeLessThanOrEqual(HARD);
  });

  test("то же с текстом до блока и с закрывашкой после", () => {
    for (const text of [
      "интро\n\n```" + manyLinks(400),
      "```" + manyLinks(400) + "\n```",
      "```js " + manyLinks(400),
      "интро " + manyLinks(200) + " ``` " + manyLinks(200),
    ]) {
      for (const p of splitForTelegram(text, HARD, FITS)) {
        expect(measure(p)).toBeLessThanOrEqual(HARD);
      }
    }
  });

  test("огромный токен сразу после ``` — мерка не врёт в опасную сторону", () => {
    // До правки: одна часть в 8410 видимых символов, померенная как 0.
    const parts = splitForTelegram("хвост\n\n```" + langRun(8400), HARD, FITS);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(measure(p)).toBeLessThanOrEqual(HARD);
  });

  test("честная мерка не вырождается в тысячи частей по два символа", () => {
    // Открывашка обрезана до 16 символов, поэтому место под содержимое
    // остаётся. Без обрезки на этом входе было бы ~2100 частей, и каждая —
    // отдельное сообщение в чат.
    const parts = splitForTelegram("хвост\n\n```" + langRun(8400), HARD, FITS);
    expect(parts.length).toBeLessThan(10);
    for (const p of parts) expect(p.trim().length).toBeGreaterThan(0);
  });

  test("перенесённая открывашка не тащит за собой длинный lang-токен", () => {
    const text = "хвост\n\n```" + langRun(8400);
    const parts = splitForTelegram(text, HARD, FITS);
    // Открывашка дописывается в начало каждой продолжающей части. Без
    // обрезки lang в неё уходил бы кусок исходного текста длиной с лимит —
    // и уходил бы столько раз, сколько частей. Считаем по суммарной длине:
    // дублирования быть не должно.
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(total).toBeLessThan(text.length + 20 * parts.length + 64);
    // А сама открывашка — не длиннее ```+16.
    for (const p of parts.slice(1)) {
      const firstLine = p.split("\n")[0]!;
      if (firstLine.startsWith("```") && firstLine.length > 19) {
        // Допустимо только там, где часть НАЧИНАЕТ блок сама, а не получила
        // открывашку с прошлой части: тогда за ``` идёт исходный текст.
        expect(text).toContain(firstLine);
      }
    }
  });
});

describe("фаззинг: ни одна часть не выше предела", () => {
  test("ссылки, фенсы и длинные токены в разных сочетаниях", () => {
    let worst = 0;
    for (const n of [40, 120, 260]) {
      for (const head of ["", "интро\n\n", "```\n", "```js\n"]) {
        for (const tail of ["", "\n```", "\n\nхвост"]) {
          const text = head + "```" + manyLinks(n) + tail;
          for (const p of splitForTelegram(text, HARD, FITS)) {
            worst = Math.max(worst, measure(p));
          }
        }
      }
    }
    // До правки здесь было 19652.
    expect(worst).toBeLessThanOrEqual(HARD);
  });
});

describe("форма исправления", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "lib", "telegram-chunking.ts"),
    "utf8",
  );

  test("резчик идёт по одному куску, а не берёт готовый массив", () => {
    // Ветка длинной строки обязана двигать carry между кусками. Жадный
    // hardSlice это делать не даёт по определению: он меряет всё сразу.
    const loop = SRC.indexOf("sliceOneEnd(line, at, limit, fits)");
    expect(loop).toBeGreaterThan(-1);
    const branch = SRC.indexOf("// длинная строка без переносов");
    expect(branch).toBeGreaterThan(-1);
    expect(SRC.indexOf("hardSlice(", branch)).toBe(-1);
  });

  test("кандидат меряется и закрытым, и незакрытым", () => {
    expect(SRC).toContain("fitsRaw(head + part) && fitsRaw(withFenceMarkers(part, carry))");
  });

  test("открывашка собирается одной функцией с обрезкой lang", () => {
    expect(SRC).toContain("MAX_FENCE_LANG");
    // Обе точки сборки — fenceOpenAfter и balanceFences — ходят через неё.
    expect(SRC.split("openMarker(").length - 1).toBeGreaterThanOrEqual(3);
    expect(SRC).not.toContain('open === null ? "```" + m[1]! : null');
  });
});
