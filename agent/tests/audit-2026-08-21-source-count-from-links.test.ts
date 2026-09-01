/**
 * Аудит 2026-08-21: бейдж «N источников» на сайте считался не по ссылкам.
 *
 * `research()` фильтрует `items` по `^https?://` — всё остальное (относительный
 * путь, «TBD», пустая строка) до сайта не доезжает. А `sourceCount` брался из
 * ответа модели, и фолбэк считал длину СЫРОГО списка, до фильтра. На
 * публичной странице дайджеста (`DigestPage`, `HomeDigests`) этот счётчик
 * стоит бейджем ровно над списком ссылок — страница обещала пять источников и
 * показывала три.
 *
 * Второй путь ингеста, `lib/site-ingest.ts`, всегда считал правильно
 * (`sourceCount: items.length`). Тесты ниже фиксируют, что теперь оба пути
 * дают один и тот же ответ на одних и тех же данных.
 */
import { describe, expect, test } from "bun:test";
import { articlesFromResearch } from "../tools/daily-draft.ts";

const base = { title: "Заголовок", body: "Тело статьи", summary: "Суть. Вторая фраза." };

const parse = (articles: unknown[]) => articlesFromResearch({ articles } as never);

describe("sourceCount считается по доехавшим ссылкам", () => {
  test("объявленное моделью число игнорируется в пользу реальных ссылок", () => {
    const [a] = parse([
      {
        ...base,
        sourceCount: 5,
        items: [
          { text: "Раз", url: "https://a.example/1" },
          { text: "Два", url: "https://b.example/2" },
        ],
      },
    ]);
    expect(a!.items.length).toBe(2);
    expect(a!.sourceCount).toBe(2);
  });

  test("отфильтрованные ссылки не считаются", () => {
    const [a] = parse([
      {
        ...base,
        items: [
          { text: "Годная", url: "https://a.example/1" },
          { text: "Относительная", url: "/local/path" },
          { text: "Заглушка", url: "TBD" },
          { text: "Без url" },
          { text: "Чужая схема", url: "ftp://a.example/x" },
        ],
      },
    ]);
    expect(a!.items.length).toBe(1);
    expect(a!.sourceCount).toBe(1);
  });

  test("модель занизила счётчик — тоже правим", () => {
    const [a] = parse([
      {
        ...base,
        sourceCount: 0,
        items: [
          { text: "Раз", url: "https://a.example/1" },
          { text: "Два", url: "https://b.example/2" },
          { text: "Три", url: "https://c.example/3" },
        ],
      },
    ]);
    expect(a!.sourceCount).toBe(3);
  });

  test("без items — ноль, а не мусор", () => {
    expect(parse([{ ...base }])[0]!.sourceCount).toBe(0);
    expect(parse([{ ...base, items: "нет" }])[0]!.sourceCount).toBe(0);
    expect(parse([{ ...base, items: [], sourceCount: 4 }])[0]!.sourceCount).toBe(0);
  });

  test("счётчик и список ссылок сходятся на любом наборе", () => {
    for (const items of [
      [],
      [{ url: "https://a.example/1" }],
      [{ url: "https://a.example/1" }, { url: "нет" }],
      [{ url: "http://a.example/1" }, { url: "https://b.example/2" }, { url: "" }],
    ]) {
      const [a] = parse([{ ...base, sourceCount: 99, items }]);
      expect(a!.sourceCount).toBe(a!.items.length);
    }
  });
});

describe("остальной разбор не поехал", () => {
  test("берём максимум четыре статьи и только с title+body", () => {
    const arts = parse([
      { ...base, title: "A" },
      { ...base, title: "" },
      { ...base, title: "B", body: "" },
      { ...base, title: "C" },
      { ...base, title: "D" },
      { ...base, title: "E" },
      { ...base, title: "F" },
    ]);
    expect(arts.map((a) => a.title)).toEqual(["A", "C", "D", "E"]);
  });

  test("текст ссылки по умолчанию — «Источник», url сохраняется как есть", () => {
    const [a] = parse([{ ...base, items: [{ url: "https://a.example/1?x=1&y=2" }] }]);
    expect(a!.items[0]).toEqual({ text: "Источник", url: "https://a.example/1?x=1&y=2" });
  });

  test("blurb — первая фраза summary, иначе заголовок", () => {
    expect(parse([{ ...base }])[0]!.blurb).toBe("Суть.");
    expect(parse([{ ...base, summary: "" }])[0]!.blurb).toBe("Заголовок");
  });

  test("дата: своя, если пришла; иначе сегодня", () => {
    expect(parse([{ ...base, date: "2026-08-19" }])[0]!.date).toBe("2026-08-19");
    expect(parse([{ ...base, date: "" }])[0]!.date).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });
});

describe("промпт больше не просит поле, которого не слушаем", () => {
  test("ни в инструкции, ни в примере JSON нет sourceCount", async () => {
    const text = await Bun.file(
      new URL("../tools/daily-draft.ts", import.meta.url).pathname,
    ).text();
    const prompt = text.slice(
      text.indexOf("function researchPrompt"),
      text.indexOf("function extractJson"),
    );
    expect(prompt).toContain("items: массив {text,url}");
    expect(prompt).not.toContain("sourceCount");
  });
});
