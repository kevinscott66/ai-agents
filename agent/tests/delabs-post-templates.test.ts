/**
 * T-740 / T-741 — два новых шаблона поста DeLabs.
 *
 * Проверяется то же, на чём уже был регресс у дайджеста, плюс то, что у новых
 * шаблонов своё:
 *
 *  • ПУСТАЯ СТРОКА между пунктами (эталон @delabsru #75). Без неё Telegram
 *    склеивает пункты в стену текста; у дайджеста этот баг уже случался и
 *    закрыт тестом digest-spacing.
 *  • «…до старта..» — двойная точка. `blurb` вырезается лукбехайндом, знак
 *    конца предложения остаётся в нём, а шаблон дописывал свой поверх.
 *    endSentence общий, но пройти мимо него в новом шаблоне — одна строка.
 *  • «undefined **Заголовок**» — необязательное поле `emoji` печаталось
 *    текстом. Черновик правится руками, поэтому поле реально бывает пустым.
 *  • Диапазон недели: «6 — 12 августа 2026», а на стыках — «30 июля — 5
 *    августа 2026» и «29 декабря 2025 — 4 января 2026». Месяц и год у левой
 *    границы печатаются только когда отличаются от правой.
 *  • Пустой вход → пустая строка. Шапка без единого пункта — не пост.
 *  • Потолок сообщения: шаблоны собираются из данных переменной длины, и пост
 *    на десяток пунктов уехал бы вторым сообщением уже без баннера.
 *
 * Ни одна функция здесь ничего не публикует: формат обоих шаблонов до первой
 * публикации согласовывается с владельцем (T-740/T-741).
 */
import { describe, test, expect } from "bun:test";
import {
  buildActivityRunText,
  buildWeeklyRecapText,
  fitsOneMessage,
} from "../lib/delabs-post-templates.ts";
import { ruDateRange, weekStart } from "../lib/delabs-text.ts";

/** Полдень UTC: сдвиг Europe/Moscow не перебрасывает дату через полночь. */
const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

describe("T-740 — отработка активностей", () => {
  const ENTRIES = [
    {
      project: "Monad",
      emoji: "🔥",
      action: "пройти тестнет: свап, стейк, мост",
      rewardType: "Аирдроп",
      status: "Потенциальный",
      deadline: "до 20 августа",
      url: "https://delabs.space/activity/12",
    },
    {
      project: "Union",
      action: "собрать поинты за переводы между сетями.",
      rewardType: "Поинты",
      status: "Подтверждён",
    },
  ];

  const text = buildActivityRunText(ENTRIES, at(2026, 8, 12));

  test("шапка: заголовок, дата, интро", () => {
    const lines = text.split("\n");
    expect(lines[0]).toBe("🛠 **Отработка активностей**");
    expect(lines[1]).toBe("🗓️ 12 августа 2026");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Что стоит сделать прямо сейчас — по шагам и без воды.");
    expect(lines[4]).toBe("");
  });

  test("между пунктами — пустая строка (эталон #75)", () => {
    expect(text).toContain("🎖 Аирдроп · ✅ Потенциальный · ⌚️ до 20 августа\n\n🔥 **Union**");
  });

  test("ссылка на гайд там, где она есть; без ссылки — просто действие", () => {
    expect(text).toContain("свап, стейк, мост. [Гайд →](https://delabs.space/activity/12)");
    expect(text).toContain("собрать поинты за переводы между сетями.\n");
    expect(text).not.toContain("[Гайд →]()");
  });

  test("пустой emoji не печатается словом undefined", () => {
    expect(text).not.toContain("undefined");
    // У второго пункта emoji не задан — подставлен штатный маркер.
    expect(text).toContain("🔥 **Union**");
  });

  test("нет двойной точки там, где действие уже закрыто точкой", () => {
    expect(text).not.toMatch(/\.\./);
    expect(text).not.toMatch(/[!?]\./);
  });

  test("метаданные разделены точкой-разделителем, а пустые — не печатаются", () => {
    expect(text).toContain("🎖 Поинты · ✅ Подтверждён");
    // У Union нет дедлайна — хвостового разделителя быть не должно.
    expect(text).not.toMatch(/·\s*$/m);
  });

  test("нет хвостовой пустой строки", () => {
    expect(text.endsWith("\n")).toBe(false);
  });

  test("пустой список — пустая строка, а не шапка без пунктов", () => {
    expect(buildActivityRunText([], at(2026, 8, 12))).toBe("");
  });

  test("многострочное поле не ломает разметку пункта", () => {
    const t = buildActivityRunText(
      [{ project: "X\nY", action: "шаг один\nшаг два" }],
      at(2026, 8, 12),
    );
    expect(t).toContain("**X Y**");
    expect(t).toContain("шаг один шаг два.");
  });
});

describe("T-741 — итоги недели", () => {
  const ARGS = {
    activities: [
      { project: "Monad", emoji: "🔥", done: "закрыли 5 из 7 шагов", url: "https://delabs.space/activity/12" },
    ],
    news: [
      { emoji: "💰", title: "ETF на SOL одобрен", blurb: "приток $300 млн за сутки", url: "https://delabs.space/digest/88" },
      { title: "Base снизила комиссии", blurb: "в среднем вдвое!" },
    ],
    ahead: "разбираем два новых тестнета",
    weekEnd: at(2026, 8, 12),
  };

  const text = buildWeeklyRecapText(ARGS);

  test("шапка с диапазоном недели", () => {
    const lines = text.split("\n");
    expect(lines[0]).toBe("🗓 **Итоги недели**");
    expect(lines[1]).toBe("6 — 12 августа 2026");
    expect(lines[3]).toBe("Что произошло и что мы отработали.");
  });

  test("оба блока на месте и в порядке: сначала активности, потом новости", () => {
    expect(text.indexOf("📌 **Активности**")).toBeGreaterThan(-1);
    expect(text.indexOf("📌 **Активности**")).toBeLessThan(text.indexOf("📰 **Новости**"));
  });

  test("между пунктами — пустая строка", () => {
    expect(text).toContain("приток $300 млн за сутки. [Подробнее →](https://delabs.space/digest/88)\n\n🔥 **Base снизила комиссии**");
  });

  test("восклицательный знак не получает точку сверху", () => {
    expect(text).toContain("в среднем вдвое!");
    expect(text).not.toContain("вдвое!.");
  });

  test("блок планов печатается одной строкой", () => {
    expect(text).toContain("⏳ **На следующей неделе:** разбираем два новых тестнета.");
  });

  test("пустые планы — блока нет", () => {
    expect(buildWeeklyRecapText({ ...ARGS, ahead: "" })).not.toContain("На следующей неделе");
  });

  test("только новости — блок активностей не печатается", () => {
    const t = buildWeeklyRecapText({ news: ARGS.news, weekEnd: at(2026, 8, 12) });
    expect(t).not.toContain("📌 **Активности**");
    expect(t).toContain("📰 **Новости**");
  });

  test("неделя без единого пункта — пустая строка", () => {
    expect(buildWeeklyRecapText({ news: [], activities: [], ahead: "что-то" })).toBe("");
  });
});

describe("диапазон недели на стыках", () => {
  test("внутри месяца — месяц и год только справа", () => {
    expect(ruDateRange(at(2026, 8, 6), at(2026, 8, 12))).toBe("6 — 12 августа 2026");
  });

  test("на стыке месяцев — месяц печатается слева", () => {
    expect(ruDateRange(at(2026, 7, 30), at(2026, 8, 5))).toBe("30 июля — 5 августа 2026");
  });

  test("на стыке годов — печатается и год", () => {
    expect(ruDateRange(at(2025, 12, 29), at(2026, 1, 4))).toBe("29 декабря 2025 — 4 января 2026");
  });

  test("weekStart отдаёт понедельник для любого дня недели", () => {
    // 2026-08-12 — среда; понедельник той недели — 10 августа.
    for (const day of [10, 11, 12, 13, 14, 15, 16]) {
      expect(ruDateRange(weekStart(at(2026, 8, day)), at(2026, 8, 16))).toBe("10 — 16 августа 2026");
    }
  });
});

describe("потолок одного сообщения", () => {
  test("обычный пост влезает", () => {
    expect(fitsOneMessage(buildWeeklyRecapText({
      news: [{ title: "A", blurb: "b" }],
      weekEnd: at(2026, 8, 12),
    }))).toBe(true);
  });

  test("пост на полсотни пунктов — не влезает, и это видно ДО отправки", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      project: `Проект номер ${i}`,
      action: "пройти тестнет целиком: свап, стейк, мост, голосование в дискорде",
      rewardType: "Аирдроп",
      status: "Потенциальный",
      deadline: "до конца месяца",
      url: `https://delabs.space/activity/${i}`,
    }));
    const t = buildActivityRunText(many, at(2026, 8, 12));
    expect(t.length).toBeGreaterThan(4096);
    expect(fitsOneMessage(t)).toBe(false);
  });

  test("запас под футер учитывается: текст под лимитом, но с футером — уже нет", () => {
    const text = "x".repeat(4000);
    expect(text.length).toBeLessThan(4096);
    expect(fitsOneMessage(text)).toBe(false);
  });
});
