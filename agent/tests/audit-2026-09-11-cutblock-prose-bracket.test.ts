/**
 * Круг 32: непарная `[` в прозе схлопывала весь блок при усечении.
 *
 * `danglingLinkStart` в ветке «`]` нет вовсе» возвращала позицию скобки
 * безусловно. `cutBlock` ищет границу двоичным поиском и чистит каждый
 * кандидат этой же функцией, поэтому кандидат любой длины схлопывался до
 * символа перед `[` — и, разумеется, «влезал». Поиск уезжал в конец блока, а
 * наружу уходил огрызок: блок в 2443 символа при лимите 1000 отдавал
 * семнадцать.
 *
 * Живой путь один и ходовой: `fitToLimit` в lib/dispatch/publish.ts зовётся на
 * каждый PUBLISH_POST длиннее лимита подписи (1024/2048 — то есть регулярно),
 * а кусок короче 40 символов там ещё и выбрасывается вместе с остатком поста.
 * Непарная `[` в новостном тексте — это `items[`, «[ANNOUNCED» без пары,
 * скобка внутри кода: не экзотика.
 *
 * Инвариант: усечение сохраняет столько текста, сколько разрешает мерка, а
 * скобка в прозе на это не влияет. Обрывом метка ссылки считается только
 * тогда, когда хвост её дочитывает и сразу переходит в `(`.
 */
import { describe, test, expect } from "bun:test";
import { cutBlock, danglingLinkStart } from "../lib/telegram-format.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";

const LIMIT = 1000;
const fits = (t: string) => t.length <= LIMIT;

describe("усечение не схлопывается на непарной `[`", () => {
  test("непарная `[` в прозе не отменяет остаток блока", () => {
    const block = "Дроп подтверждён [ANNOUNCED — детали ниже. " + "текст ".repeat(400);
    const out = cutBlock(block, fits);
    expect(out.length).toBeGreaterThan(900);
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out.startsWith("Дроп подтверждён [ANNOUNCED — детали ниже.")).toBe(true);
  });

  test("та же скобка в коде ведёт себя так же", () => {
    const block = "Итог по бэклогу: см. массив items[ и дальше. " + "хвост ".repeat(400);
    expect(cutBlock(block, fits).length).toBeGreaterThan(900);
  });

  test("закрытая пара как была, так и осталась цела", () => {
    const block = "Дроп подтверждён [ANNOUNCED] — детали ниже. " + "текст ".repeat(400);
    expect(cutBlock(block, fits).length).toBeGreaterThan(900);
  });

  test("настоящий обрыв `](url` по-прежнему отрезается целиком", () => {
    // Здесь скобка рвётся вместе с URL, и остаток `[условия](https://…` —
    // не проза, а половина разметки. Эту ветку мы не трогали.
    const block = "текст ".repeat(160) + "[условия](https://example.com/очень/длинный/путь";
    const out = cutBlock(block, fits);
    expect(out).not.toContain("[условия](");
  });
});

describe("разбиение не отдаёт огрызок первой частью", () => {
  test("непарная `[` в начале длинной строки не рождает лишнее сообщение", () => {
    // Одна строка без переносов длиннее лимита — путь `sliceOneEnd`.
    const line = "Статус дропа [ANNOUNCED и что дальше: " + "слово ".repeat(1500);
    const parts = splitForTelegram(line);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.length).toBeGreaterThan(1000);
  });

  test("разорванная пополам ссылка по-прежнему переезжает целиком", () => {
    const label = "[читать подробнее про условия участия]";
    const line = "слово ".repeat(660) + label + "(https://example.com/x)" + " хвост".repeat(50);
    const parts = splitForTelegram(line);
    const joined = parts.join("");
    // Метка и url не должны разъехаться по двум сообщениям.
    for (const p of parts) {
      const i = p.indexOf("[читать подробнее");
      if (i !== -1) expect(p.slice(i)).toContain("](https://example.com/x)");
    }
    expect(joined).toContain(label);
  });
});

describe("хвост — единственный свидетель обрыва метки", () => {
  test("без хвоста доказательства нет", () => {
    expect(danglingLinkStart("абзац [метка")).toBe(-1);
  });

  test("хвост с `](` — доказательство есть", () => {
    const s = "абзац [метка";
    expect(danglingLinkStart(s, " длинная](url)")).toBe(s.indexOf("["));
  });
});
