/**
 * Аудит 2026-08-28: заголовки пунктов уезжали в описание карточки.
 *
 * Вступление резалось по первой строке СО ССЫЛКОЙ. Но домашний формат поста
 * (tools-schema.ts:332 — «2-3 строки описания под каждым заголовком») ставит
 * заголовок пункта на отдельную строку, а ссылку даёт ниже: между границей и
 * настоящим началом пункта оказывались все его заголовки.
 *
 * Проверяем на выходе самих шаблонов, а не на выдуманной разметке: до правки
 * ни один тест не прогонял `buildActivityRunText`/`buildWeeklyRecapText` через
 * `parseDigestPost`, поэтому дефект и дожил до сайта. Уходит это на публичный
 * delabs.space и в RSS, обратного хода нет.
 */
import { describe, expect, test } from "bun:test";
import { parseDigestPost } from "../lib/site-ingest.ts";
import { buildActivityRunText, buildWeeklyRecapText } from "../lib/delabs-post-templates.ts";

const WEEK_END = new Date(2026, 7, 27);

describe("вывод шаблонов", () => {
  test("«Отработка активностей»: описание — только вступление", () => {
    const text = buildActivityRunText(
      [
        {
          project: "Monad",
          action: "зайти в тестнет и сделать своп",
          url: "https://monad.xyz",
          emoji: "🔥",
          rewardType: "Подтверждён",
          status: "идёт",
        },
      ],
      WEEK_END,
    );
    const d = parseDigestPost(text);
    expect(d.title).toBe("Отработка активностей");
    expect(d.summary).toBe("Что стоит сделать прямо сейчас — по шагам и без воды.");
    // Ссылку пункта по-прежнему видим — резка вступления её не задевает.
    expect(d.items).toEqual([{ text: "Гайд →", url: "https://monad.xyz" }]);
  });

  test("«Итоги недели»: ни заголовков разделов, ни заголовков пунктов", () => {
    const text = buildWeeklyRecapText({
      news: [{ title: "Zora дроп", blurb: "раздали токены", url: "https://zora.co" }],
      activities: [{ project: "Monad", done: "сделали своп" }],
      ahead: "смотрим на Linea",
      weekEnd: WEEK_END,
    });
    const d = parseDigestPost(text);
    expect(d.summary).toContain("Что произошло и что мы отработали.");
    for (const head of ["Активности", "Новости", "Monad", "Zora дроп"]) {
      expect(d.summary).not.toContain(head);
    }
  });

  test("несколько пунктов: в описании нет ни одного из них", () => {
    const text = buildActivityRunText(
      [
        { project: "Monad", action: "своп", emoji: "🔥" },
        { project: "Linea", action: "мост", emoji: "⭐️", url: "https://linea.build" },
      ],
      WEEK_END,
    );
    const d = parseDigestPost(text);
    expect(d.summary).toBe("Что стоит сделать прямо сейчас — по шагам и без воды.");
  });
});

describe("граница вступления", () => {
  test("заголовок пункта до ссылки закрывает вступление", () => {
    const d = parseDigestPost(
      ["**Шапка**", "Вступление.", "", "🔥 **Пункт**", "Описание [ссылка](https://x.test)"].join(
        "\n",
      ),
    );
    expect(d.summary).toBe("Вступление.");
  });

  test("строки пункта между его заголовком и ссылкой тоже не попадают", () => {
    const d = parseDigestPost(
      [
        "**Шапка**",
        "Вступление.",
        "",
        "🔥 **Пункт**",
        "Зайти в тестнет.",
        "🎖 Подтверждён",
        "[Гайд](https://x.test)",
      ].join("\n"),
    );
    expect(d.summary).toBe("Вступление.");
  });

  test("проза с выделением внутри строки пунктом не считается", () => {
    const d = parseDigestPost(
      ["**Шапка**", "**Важно:** читаем до конца.", "", "[Гайд](https://x.test)"].join("\n"),
    );
    expect(d.summary).toBe("Важно: читаем до конца.");
  });

  test("сама строка заголовка поста вступление не закрывает", () => {
    // Иначе summary схлопывался бы в title на каждом посте.
    const d = parseDigestPost(["🔥 **Шапка**", "Вступление.", "[a](https://x.test)"].join("\n"));
    expect(d.summary).toBe("Вступление.");
  });

  test("пост без прозы во вступлении вступление — заголовки пунктов, откатывается на title", () => {
    const d = parseDigestPost(["**Шапка**", "", "🔥 **Пункт**", "[a](https://x.test)"].join("\n"));
    expect(d.summary).toBe("Шапка");
  });

  test("заголовок пункта ПОСЛЕ первой ссылки границу не двигает", () => {
    const d = parseDigestPost(
      ["**Шапка**", "Вступление [ссылка](https://x.test)", "🔥 **Пункт**"].join("\n"),
    );
    // Первая же строка со ссылкой и так закрывала вступление.
    expect(d.summary).toBe("Шапка");
  });
});

describe("неизменное поведение", () => {
  test("пост без пунктов: вступление берётся целиком", () => {
    const d = parseDigestPost(["**Шапка**", "Первая строка.", "Вторая строка."].join("\n"));
    expect(d.summary).toBe("Первая строка. Вторая строка.");
  });

  test("items и sourceCount от резки вступления не зависят", () => {
    const d = parseDigestPost(
      ["**Шапка**", "🔥 **Пункт**", "[a](https://x.test) и [b](https://y.test)"].join("\n"),
    );
    expect(d.sourceCount).toBe(2);
    expect(d.items.map((i) => i.url)).toEqual(["https://x.test", "https://y.test"]);
  });
});
