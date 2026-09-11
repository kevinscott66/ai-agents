/**
 * Аудит 2026-09-11: шаг 4 конвертера md→HTML был квадратичен по числу `[`.
 *
 * Правило «ссылка» записывалось как `\[([^\]\n]+)\]\((https?:…)\)`. Каждая
 * открывающая скобка — стартовая позиция; `[^\]\n]+` прочёсывает строку до
 * ближайшего `]`, а если его нет — до конца строки, и ровно столько же шагов
 * откатывается, проверяя `\]` в каждой точке. Замер на строке из одних `[`:
 * 5000 — 19 мс, 10000 — 66, 20000 — 264, 40000 — 1054. Вчетверо на каждое
 * удвоение, то есть ровно O(n²).
 *
 * Считается это не по разу. `HTML_MESSAGE_FITS` меряет часть через
 * `plainTelegramLength`, а тот гоняет ВЕСЬ конвертер; `splitForTelegram`
 * спрашивает мерку на каждый кусок и ещё раз на весь текст целиком. Сорок
 * тысяч `[` держали цикл событий 4527 мс — на это время не идёт ни long
 * polling, ни miniapp-сервер, ни один таймер. Это отказ процесса, а не порча
 * одного сообщения, и на этом же держится разница в серьёзности: испорченную
 * разметку видит читатель, остановившийся цикл — никто.
 *
 * Вход недоверенный в том же смысле, что и на шаге 0 конвертера: тело
 * текстового вложения READ_FILE, выдача web_search, текст пользователя —
 * агент цитирует их дословно. Строка из `[` не требует ни подбора, ни
 * попадания в редкую ветку.
 *
 * Почему переписано, а не ограничено квантором. `{1,N}` чинит стоимость, но
 * молча перестаёт собирать ссылку с текстом длиннее N — то есть меняет
 * ПОВЕДЕНИЕ на входе, который до сих пор работал. `replaceMarkdownLinks` ищет
 * с другого конца — сначала хвост `](url)`, потом назад до ближайшего `]`,
 * перевода строки или конца предыдущей замены — и описывает тот же язык. Что
 * это действительно тот же язык, доказывает дифференциальный тест ниже:
 * прежняя регулярка и новая функция гоняются по одному корпусу и обязаны
 * совпасть символ в символ.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mdToTelegramHtml,
  plainTelegramLength,
  replaceMarkdownLinks,
} from "../lib/telegram-format.ts";
import { splitForTelegram, HTML_MESSAGE_FITS } from "../lib/telegram-chunking.ts";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "telegram-format.ts"), "utf8");

/** Ровно та регулярка, что стояла до правки. Живёт только здесь. */
const OLD = () => /\[([^\]\n]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g;
const render = (t: string, u: string) => `<A t=${t} u=${u}>`;
const viaOld = (s: string) => s.replace(OLD(), (_m, t: string, u: string) => render(t, u));

describe("стоимость линейна по длине входа", () => {
  test("сорок тысяч `[` больше не держат цикл событий", () => {
    const bomb = "[".repeat(40_000) + "](ftp://x)";
    const t0 = performance.now();
    const parts = splitForTelegram(bomb, 4000, HTML_MESSAGE_FITS);
    const ms = performance.now() - t0;
    expect(parts.length).toBeGreaterThan(1);
    // Замер находки — 4527 мс, после правки 6 мс. Порог намеренно далеко от
    // обоих: тест должен ловить возврат квадратичности, а не дрожь машины.
    expect(ms).toBeLessThan(1000);
  });

  test("учетверение входа не даёт шестнадцатикратной цены", () => {
    const cost = (n: number) => {
      const s = "[".repeat(n) + "](ftp://x)";
      plainTelegramLength(s); // прогрев: первый прогон тащит за собой JIT
      const t0 = performance.now();
      plainTelegramLength(s);
      return performance.now() - t0;
    };
    const small = cost(20_000);
    const big = cost(80_000);
    // Квадратичная зависимость дала бы ×16 — и около 4 с в абсолюте на 80k.
    // Порог по абсолютному времени, а не по отношению: на линейных величинах
    // в единицы миллисекунд отношение — это шум, а не сигнал.
    expect(small + big).toBeLessThan(500);
  });

  test("длинный текст ссылки по-прежнему собирается целиком", () => {
    // Ровно то, чего стоил бы фикс квантором `{1,N}`.
    const long = "т".repeat(3000);
    const html = mdToTelegramHtml(`[${long}](https://delabs.space/p)`);
    expect(html).toBe(`<a href="https://delabs.space/p">${long}</a>`);
  });
});

describe("язык остался прежним", () => {
  const cases = [
    "[a](http://x)",
    "[a[b](http://x)",
    "[[a]](http://x)",
    "[](http://x)",
    "[a\nb](http://x)",
    "x] [a](http://x)",
    "[a](ftp://x)[b](http://y)",
    "[a](http://x)[b](http://y)",
    "](http://x)",
    "[a](http://x",
    "[a](http://x)) [b](http://y)",
    "[a](http:// x)",
    "нет ссылок вовсе",
    "[внешний [внутренний]](https://y.z/p)",
  ];

  for (const s of cases) {
    test(`совпадает с прежней регуляркой: ${JSON.stringify(s)}`, () => {
      expect(replaceMarkdownLinks(s, render)).toBe(viaOld(s));
    });
  }

  test("дифференциальный прогон по псевдослучайному корпусу", () => {
    // Алфавит подобран так, чтобы почти каждая строка задевала разбор:
    // скобки, переносы, схемы — и мимо-схема `ftp`, на которой хвост есть, а
    // ссылки нет. Генератор детерминирован: падение воспроизводимо.
    const alpha = [
      "[",
      "]",
      "(",
      ")",
      "\n",
      "a",
      " ",
      "[",
      "]",
      "http://x",
      "https://y.z/p",
      "ftp://q",
      " ",
      "!",
    ];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let checked = 0;
    for (let i = 0; i < 20_000; i++) {
      const len = 1 + Math.floor(rnd() * 14);
      let s = "";
      for (let k = 0; k < len; k++) s += alpha[Math.floor(rnd() * alpha.length)]!;
      expect(replaceMarkdownLinks(s, render)).toBe(viaOld(s));
      checked++;
    }
    expect(checked).toBe(20_000);
  });

  test("самая левая открывашка окна выигрывает — как перебор стартов у движка", () => {
    expect(replaceMarkdownLinks("[a[b](http://x)", render)).toBe("<A t=a[b u=http://x>");
  });

  test("повторный вызов даёт тот же ответ — lastIndex не течёт между вызовами", () => {
    const s = "[a](http://x) и [b](http://y)";
    const first = replaceMarkdownLinks(s, render);
    expect(replaceMarkdownLinks(s, render)).toBe(first);
    expect(first).toBe("<A t=a u=http://x> и <A t=b u=http://y>");
  });
});

describe("прежние инварианты шага 4 на месте", () => {
  test("плейсхолдер кода не уезжает в href (аудит 2026-08-29)", () => {
    const html = mdToTelegramHtml("See [doc](https://x.tld/a`v1`/b)");
    expect(html).not.toContain('href="https://x.tld/a<code>');
    expect(html).toContain("<code>v1</code>");
  });

  test("кавычка в адресе по-прежнему экранируется", () => {
    expect(mdToTelegramHtml('[a](https://x.tld/?q=")')).toContain('href="https://x.tld/?q=%22"');
  });
});

describe("квадратичной записи в коде не осталось", () => {
  test("шаг 4 зовёт replaceMarkdownLinks, а не text.replace", () => {
    const step4 = SRC.slice(SRC.indexOf("// 4) Links"), SRC.indexOf("// 4b) Голые ссылки"));
    const code = step4
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).toContain("replaceMarkdownLinks(");
    expect(code).not.toContain("text.replace(");
    // Класс-прочёсыватель остался только цитатой в комментарии и в докблоке —
    // в исполняемых строках шага его быть не должно.
    expect(code).not.toContain("[^\\]\\n]+");
  });

  test("хвостовая регулярка создаётся заново на каждый вызов", () => {
    // `/g` хранит lastIndex в самом объекте: общий экземпляр между вызовами —
    // ровно тот дефект, что уже ловили в других файлах этого репозитория.
    expect(SRC).toContain("const linkTailRe = () =>");
  });
});
