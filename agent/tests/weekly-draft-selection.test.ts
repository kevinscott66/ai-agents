/**
 * T-741, вторая половина: отбор материала в недельный пост.
 *
 * Главное здесь — граница недели. `weekStart` отдаёт ПОЛДЕНЬ понедельника: там
 * это правильно (нужна дата, и сдвиг пояса не должен перебросить её через
 * полночь), но границей окна отбора такой момент быть не может. Замер:
 *
 *   weekStart(2026-08-10T08:00Z)  = 2026-08-10T12:00:00Z  → дайджест НЕ в окне
 *   tzDayStart(weekStart(...))    = 2026-08-09T21:00:00Z  → дайджест в окне
 *
 * Дневной дайджест выходит в 08:00 UTC, то есть понедельничный выпуск левее
 * полудня — при наивной границе он бы выпадал из СВОЕЙ недели каждую неделю и
 * при этом не попадал в следующую (окно полуоткрытое). Раз в неделю пропадал бы
 * ровно один пункт, и заметить это можно было только сверив пост с сайтом.
 *
 * Полуоткрытость окна проверяется отдельно: с закрытым справа запись, попавшая
 * ровно в полночь понедельника, вышла бы в двух постах подряд.
 */
import { describe, expect, test } from "bun:test";
import {
  weekBounds,
  selectWeekNews,
  selectWeekActivities,
  buildWeeklyTextFitting,
  buildWeeklyPending,
  type SiteDigestRow,
  type SiteActivityRow,
} from "../tools/weekly-draft.ts";
import { fitsOneMessage } from "../lib/delabs-post-templates.ts";
import { ITEM_EMOJI } from "../lib/delabs-text.ts";

// Воскресенье 16 августа 2026, вечер по Москве — штатное время прогона.
const SUNDAY_RUN = new Date("2026-08-16T18:00:00Z");

describe("границы недели", () => {
  const { from, to } = weekBounds(SUNDAY_RUN);

  test("окно начинается в полночь понедельника по поясу канала", () => {
    expect(from.toISOString()).toBe("2026-08-09T21:00:00.000Z"); // = 10 авг 00:00 MSK
    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("понедельничный дайджест 08:00 UTC попадает в свою неделю", () => {
    const monday = new Date("2026-08-10T08:00:00Z");
    expect(monday >= from && monday < to).toBe(true);
  });

  test("окно полуоткрытое: полночь следующего понедельника уже не наша", () => {
    const nextWeek = new Date("2026-08-16T21:00:00Z"); // 17 авг 00:00 MSK
    expect(nextWeek < to).toBe(false);
    // И она попадёт в следующее окно ровно один раз.
    expect(weekBounds(nextWeek).from.getTime()).toBe(to.getTime());
  });
});

describe("отбор новостей", () => {
  const { from, to } = weekBounds(SUNDAY_RUN);
  const rows: SiteDigestRow[] = [
    { id: "d1", title: "Прошлая неделя", date: "2026-08-08T08:00:00Z", summary: "Старое." },
    { id: "d2", title: "Понедельник", date: "2026-08-10T08:00:00Z", summary: "Первое предложение. Второе предложение." },
    { id: "d3", title: "Среда", date: "2026-08-12T08:00:00Z", summary: "Среда." },
    { id: "d4", title: "Суббота", date: "2026-08-15T08:00:00Z", summary: "Суббота." },
  ];

  test("берём только записи недели, свежие сверху", () => {
    const news = selectWeekNews(rows, from, to);
    expect(news.map((n) => n.title)).toEqual(["Суббота", "Среда", "Понедельник"]);
  });

  test("блёрб — первая фраза описания, а не весь абзац", () => {
    const news = selectWeekNews(rows, from, to);
    expect(news.at(-1)!.blurb).toBe("Первое предложение.");
  });

  test("ссылка ведёт на страницу дайджеста на сайте", () => {
    expect(selectWeekNews(rows, from, to)[0]!.url).toBe("https://delabs.space/digest/d4");
  });

  test("маркеры пунктов чередуются, а не повторяют один значок", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      id: `x${i}`,
      title: `T${i}`,
      date: `2026-08-1${i + 1}T08:00:00Z`,
      summary: "s",
    }));
    const emojis = selectWeekNews(many, from, to).map((n) => n.emoji);
    expect(new Set(emojis).size).toBe(Math.min(4, ITEM_EMOJI.length));
  });

  test("лимит соблюдается", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`, title: `T${i}`, date: "2026-08-12T08:00:00Z", summary: "s",
    }));
    expect(selectWeekNews(many, from, to).length).toBe(6);
    expect(selectWeekNews(many, from, to, 2).length).toBe(2);
  });

  test("битая дата не роняет отбор и не попадает в пост", () => {
    const bad: SiteDigestRow[] = [{ id: "b", title: "B", date: "не дата", summary: "s" }];
    expect(selectWeekNews(bad, from, to)).toEqual([]);
  });
});

describe("отбор активностей", () => {
  const { from, to } = weekBounds(SUNDAY_RUN);
  const rows: SiteActivityRow[] = [
    { id: "7", project: "Monad", title: "Monad", emoji: "🔥", date: "2026-08-11T10:00:00Z", rewardType: "Аирдроп", status: "Активна" },
    { id: "8", project: "Old", title: "Old", date: "2026-08-01T10:00:00Z" },
  ];

  test("в пост идёт проект, тип награды и ссылка на гайд", () => {
    const [a] = selectWeekActivities(rows, from, to);
    expect(a!.project).toBe("Monad");
    expect(a!.done).toBe("Аирдроп · Активна");
    expect(a!.url).toBe("https://delabs.space/activity/7");
    expect(selectWeekActivities(rows, from, to).length).toBe(1);
  });

  test("без rewardType/status строка всё равно осмысленная, а не пустая", () => {
    const bare: SiteActivityRow[] = [{ id: "9", project: "P", title: "P", date: "2026-08-11T10:00:00Z" }];
    expect(selectWeekActivities(bare, from, to)[0]!.done).toBe("разобрали гайд");
  });
});

describe("пост влезает в одно сообщение", () => {
  const weekEnd = new Date("2026-08-16T12:00:00Z");
  const long = (i: number) => "Очень длинное описание пункта номер " + i + ", ".repeat(1) + "х".repeat(180);

  test("двадцать пунктов ужимаются до одного сообщения", () => {
    const news = Array.from({ length: 20 }, (_, i) => ({
      emoji: "🔥", title: `Новость ${i} ` + "я".repeat(60), blurb: long(i), url: `https://delabs.space/digest/n${i}`,
    }));
    const activities = Array.from({ length: 20 }, (_, i) => ({
      emoji: "💰", project: `Проект ${i}`, done: long(i), url: `https://delabs.space/activity/a${i}`,
    }));
    const raw = buildWeeklyTextFitting({ news, activities, weekEnd });
    expect(fitsOneMessage(raw)).toBe(true);
    // Режем с конца — самое свежее (оно наверху) остаётся.
    expect(raw).toContain("Новость 0");
    expect(raw).toContain("Проект 0");
  });

  test("короткий пост не трогаем", () => {
    const news = [{ emoji: "🔥", title: "T", blurb: "b", url: "https://delabs.space/digest/1" }];
    const text = buildWeeklyTextFitting({ news, activities: [], weekEnd });
    expect(text).toContain("🔥 **T**");
    expect(fitsOneMessage(text)).toBe(true);
  });

  test("пустая неделя даёт пустую строку, а не шапку без пунктов", () => {
    expect(buildWeeklyTextFitting({ news: [], activities: [], weekEnd })).toBe("");
  });
});

describe("черновик недели", () => {
  test("без id превью черновик не пишется — апрув искать было бы не по чему", () => {
    expect(buildWeeklyPending({}, "текст")).toBeNull();
    expect(buildWeeklyPending({ updates: [] }, "текст")).toBeNull();
  });

  test("пустой текст в очередь не попадает", () => {
    expect(buildWeeklyPending({ id: 5 }, "   ")).toBeNull();
  });

  test("kind и text проставлены, articles пуст", () => {
    const p = buildWeeklyPending({ id: 5 }, "текст", "2026-08-16T18:00:00.000Z")!;
    expect(p.kind).toBe("weekly");
    expect(p.text).toBe("текст");
    expect(p.articles).toEqual([]);
    expect(p.previewMsgId).toBe(5);
    expect(p.createdAt).toBe("2026-08-16T18:00:00.000Z");
  });
});
