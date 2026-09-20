/**
 * Редактура сайта выходит на публичный delabs.space без человека: таймер
 * раз в сутки, апрува нет. Значит, единственное, что стоит между выдумкой
 * модели и читателем, — проверки в checkEntry и отбор в pickPending. Эти тесты
 * про них, а не про качество текста: качество проверяет промпт, а здесь —
 * что заведомо негодное не доедет до страницы.
 *
 * Отдельный сюжет — два слоя редактуры. Человек правит на Mac
 * (snapshot/editorial.json), агент пишет на сервере (/var/lib). Первый же
 * прогон, где агент возьмётся за выпуск, уже вычитанный человеком, — это
 * затёртая чужая работа, поэтому отбор обязан видеть оба слоя.
 */
import { describe, expect, test } from "bun:test";
import {
  BODY_MIN,
  EDITORIAL_BATCH,
  EDITORIAL_MAX_TURNS,
  SUMMARY_MIN,
  TITLE_MAX,
  TITLE_MIN,
  checkEntry,
  dropSelfLink,
  editorialPrompt,
  extractJson,
  pickPending,
  styleExamples,
  type EditorialEntry,
  type RawDigest,
} from "../tools/site-editorial.ts";

const digest = (over: Partial<RawDigest> = {}): RawDigest => ({
  id: "2026-09-20-fermah-waitlist",
  title: "Fermah: Открыт Waitlist",
  date: "2026-09-20",
  origin: "telegram",
  summary: "Fermah открыл вайтлист.",
  items: [{ text: "Анонс", url: "https://x.com/fermah/status/1" }],
  ...over,
});

const good = (over: Partial<EditorialEntry> = {}): EditorialEntry => ({
  title: "Fermah открыл вайтлист маркетплейса доказательств — заявки принимают до конца октября",
  summary: `**20 сентября** Fermah открыл вайтлист. ${"Деталь. ".repeat(10)}`,
  body: "Абзац. ".repeat(80),
  items: [{ text: "Анонс в X", url: "https://x.com/fermah/status/1" }],
  ...over,
});

describe("checkEntry — что не пустим на сайт", () => {
  test("нормальная запись проходит", () => {
    expect(checkEntry(good(), digest())).toEqual([]);
  });

  test("заголовок-ярлык отбивается: ровно от него мы и уходим", () => {
    const bad = checkEntry(good({ title: "Fermah: Открыт вайтлист маркетплейса доказательств навсегда" }), digest());
    expect(bad.join(" ")).toContain("ярлык");
  });

  test("заголовок, не отличающийся от канального, — это не редактура", () => {
    const raw = digest();
    // Длину подгоняем, чтобы сработала именно проверка на совпадение.
    const same = { ...raw, title: "Fermah открыл вайтлист маркетплейса доказательств по заявкам" };
    expect(checkEntry(good({ title: same.title }), same).join(" ")).toContain("не изменился");
  });

  test("границы длины заданы так, что коротыш и простыня не пройдут", () => {
    expect(checkEntry(good({ title: "Коротко" }), digest()).length).toBe(1);
    expect(checkEntry(good({ title: "Длинно ".repeat(40) }), digest()).length).toBe(1);
    expect(checkEntry(good({ summary: "Два слова." }), digest()).length).toBe(1);
    expect(checkEntry(good({ body: "Абзац." }), digest()).length).toBe(1);
  });

  test("потерянная ссылка поста — отказ: источник для читателя важнее гладкости", () => {
    const bad = checkEntry(good({ items: [{ text: "Другое", url: "https://example.com/other" }] }), digest());
    expect(bad.join(" ")).toContain("x.com/fermah/status/1");
  });

  test("ссылка не по http(s) не проходит: в вёрстке это битый источник", () => {
    const e = good({ items: [{ text: "Анонс", url: "javascript:alert(1)" }] });
    expect(checkEntry(e, digest()).length).toBeGreaterThan(0);
  });

  test("пустые поля отбиваются все сразу, а не по одному за прогон", () => {
    const bad = checkEntry({ title: "", summary: "", body: "" }, digest());
    expect(bad.length).toBeGreaterThanOrEqual(3);
  });
});

describe("pickPending — кого берём в работу", () => {
  const rows: RawDigest[] = [
    digest({ id: "a", date: "2026-09-18" }),
    digest({ id: "b", date: "2026-09-20" }),
    digest({ id: "c", date: "2026-09-19" }),
    digest({ id: "api", date: "2026-09-20", origin: "api" }),
  ];
  const empty = { digests: {} };

  test("берём только выпуски канала: у выпусков API редактура своя", () => {
    const ids = pickPending(rows, empty, empty).map((d) => d.id);
    expect(ids).not.toContain("api");
  });

  test("свежие вперёд: читателю важнее сегодняшний выпуск, чем позавчерашний", () => {
    expect(pickPending(rows, empty, empty).map((d) => d.id)).toEqual(["b", "c", "a"]);
  });

  test("вычитанное человеком не трогаем — иначе агент затрёт чужую работу", () => {
    const manual = { digests: { b: good() } };
    expect(pickPending(rows, manual, empty).map((d) => d.id)).toEqual(["c", "a"]);
  });

  test("и своё вчерашнее тоже: прогон не переписывает сам себя каждые сутки", () => {
    const auto = { digests: { c: good() } };
    expect(pickPending(rows, empty, auto).map((d) => d.id)).toEqual(["b", "a"]);
  });

  test("за прогон берётся не больше объявленного: таймаут юнита конечен", () => {
    const many = Array.from({ length: 50 }, (_, i) => digest({ id: `d${i}`, date: "2026-09-20" }));
    expect(pickPending(many, empty, empty).length).toBe(EDITORIAL_BATCH);
  });
});

describe("dropSelfLink — ссылка на сам пост", () => {
  const d = digest({ sourceUrl: "https://t.me/delabsru/3034" });

  test("из источников вычитается: страница показывает её отдельной строкой", () => {
    const items = [
      { text: "Анонс", url: "https://x.com/fermah/status/1" },
      { text: "Пост в канале", url: "https://t.me/delabsru/3034" },
    ];
    expect(dropSelfLink(items, d).map((i) => i.url)).toEqual(["https://x.com/fermah/status/1"]);
  });

  test("но если пост сам на себя ссылался, ссылка остаётся: терять ссылки поста нельзя", () => {
    const self = { text: "Пост", url: "https://t.me/delabsru/3034" };
    const withSelf = { ...d, items: [self] };
    expect(dropSelfLink([self], withSelf)).toEqual([self]);
    // И проверка целостности после вычитания по-прежнему довольна.
    expect(checkEntry(good({ items: [self] }), withSelf)).toEqual([]);
  });
});

describe("промпт", () => {
  test("несёт пост целиком: факты берутся из него, а не из памяти модели", () => {
    const d = digest({ summary: "Fermah открыл вайтлист на 30 дней." });
    const p = editorialPrompt(d, []);
    expect(p).toContain(d.title);
    expect(p).toContain("Fermah открыл вайтлист на 30 дней.");
    expect(p).toContain("https://x.com/fermah/status/1");
  });

  test("требования в промпте — те же числа, что и в проверках", () => {
    // Иначе агент пишет по одним правилам, а отбраковывается по другим, и
    // прогон молча выдаёт ноль записей при исправной работе.
    const p = editorialPrompt(digest(), []);
    expect(p).toContain(String(TITLE_MIN));
    expect(p).toContain(String(TITLE_MAX));
    expect(p).toContain(String(SUMMARY_MIN));
    expect(p).toContain(String(BODY_MIN));
    expect(p).toContain(String(EDITORIAL_MAX_TURNS));
  });

  test("образцы стиля берутся из живой редактуры сайта", () => {
    const manual = { digests: { x: good({ title: "ОБРАЗЕЦ ЗАГОЛОВКА" }) } };
    expect(styleExamples(manual).length).toBe(1);
    expect(editorialPrompt(digest(), styleExamples(manual))).toContain("ОБРАЗЕЦ ЗАГОЛОВКА");
  });

  test("пустой редакционный слой не роняет прогон, просто нет образцов", () => {
    expect(styleExamples({ digests: {} })).toEqual([]);
    expect(editorialPrompt(digest(), [])).toContain("Что нужно:");
  });
});

describe("разбор ответа", () => {
  test("JSON вынимается из болтовни вокруг", () => {
    const j = extractJson('Готово:\n```json\n{"title":"т","summary":"с"}\n```\nвот так');
    expect(j).toEqual({ title: "т", summary: "с" });
  });

  test("скобка внутри строки не обрывает разбор — иначе теряем тело со ссылкой", () => {
    const j = extractJson('{"body":"текст { и \\" кавычка","title":"т"}');
    expect((j as { body: string }).body).toBe('текст { и " кавычка');
  });

  test("ответ без JSON — это ошибка, а не пустая запись на сайте", () => {
    expect(() => extractJson("не осилил")).toThrow();
  });
});
