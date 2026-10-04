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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACT_TITLE_MAX,
  ACT_TITLE_MIN,
  BODY_MIN,
  EDITORIAL_BATCH,
  EDITORIAL_MAX_TURNS,
  INTRO_MAX,
  INTRO_MIN,
  SUMMARY_MIN,
  SUMMARY_MAX,
  BODY_MAX,
  retryNote,
  TITLE_MAX,
  TITLE_MIN,
  activityPrompt,
  checkActivity,
  checkEntry,
  dropSelfLink,
  editorialPrompt,
  extractJson,
  pickPending,
  readCorpus,
  siteTree,
  styleExamples,
  type EditorialEntry,
  type RawActivity,
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
  summary: `**20 сентября** Fermah открыл вайтлист. ${"Деталь. ".repeat(20)}`,
  body: `${"Абзац. ".repeat(45)}\n\n${"Абзац. ".repeat(45)}`,
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

  test("виды разведены: бюджет выпусков не съедает бюджет активностей", () => {
    // С одним общим числом новости (их 3-7 в день) выбирали бы его целиком, и
    // активности не редактировались бы никогда.
    const acts = [{ id: "act", title: "Отрабатываем тестнет", origin: "telegram", date: "2026-09-20" }];
    const busy = { digests: {}, activities: {} };
    expect(pickPending(acts as RawActivity[], busy, busy, "activities").map((a) => a.id)).toEqual(["act"]);
    expect(pickPending(rows, busy, { digests: { b: good(), c: good(), a: good() } }, "digests")).toEqual([]);
  });

  test("за прогон берётся не больше объявленного: таймаут юнита конечен", () => {
    const many = Array.from({ length: 50 }, (_, i) => digest({ id: `d${i}`, date: "2026-09-20" }));
    expect(pickPending(many, empty, empty).length).toBe(EDITORIAL_BATCH.digests);
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

describe("активности — заголовок зовёт тратить время, поэтому строже", () => {
  const act = (over: Partial<RawActivity> = {}): RawActivity => ({
    id: "lora-testnet",
    title: "Отрабатываем новый тестнет Lora и фармим дроп",
    project: "Lora",
    intro: "**Lora Finance** анонсировали запуск платформы в тестовом режиме.",
    steps: ["Переходим на сайт и запрашиваем тестовые токены."],
    origin: "telegram",
    date: "2026-03-25",
    ...over,
  });

  const okAct = (over: Partial<EditorialEntry> = {}): EditorialEntry => ({
    title: "Lora открыла тестнет аренды ценовой экспозиции на MegaETH — токен и дроп команда не анонсировала",
    intro: `**Lora** запустила тестнет. ${"Деталь предложения. ".repeat(20)}`,
    ...over,
  });

  test("нормальная карточка проходит", () => {
    expect(checkActivity(okAct(), act())).toEqual([]);
  });

  test("без оговорки после тире не пускаем: это половина пользы заголовка", () => {
    const bad = checkActivity(okAct({ title: "Lora открыла тестнет аренды ценовой экспозиции на MegaETH и раздаёт очки" }), act());
    expect(bad.join(" ")).toContain("после тире");
  });

  test("заголовок без названия проекта не годится: карточку ищут по проекту", () => {
    const bad = checkActivity(okAct({ title: "Команда открыла тестнет аренды экспозиции на MegaETH — токен не анонсирован" }), act());
    expect(bad.join(" ")).toContain("Lora");
  });

  test("границы интро отбивают и отписку, и простыню", () => {
    expect(checkActivity(okAct({ intro: "Коротко." }), act()).length).toBe(1);
    expect(checkActivity(okAct({ intro: "Длинно. ".repeat(200) }), act()).length).toBe(1);
    expect(INTRO_MIN).toBeLessThan(INTRO_MAX);
    expect(ACT_TITLE_MIN).toBeLessThan(ACT_TITLE_MAX);
  });

  test("оставленное как в канале — не редактура", () => {
    const a = act();
    const same = checkActivity({ title: a.title, intro: a.intro }, a).join(" ");
    expect(same).toContain("не изменил");
  });

  test("промпт несёт шаги, но запрещает их трогать: ошибка там стоит читателю денег", () => {
    const p = activityPrompt(act(), []);
    expect(p).toContain("Переходим на сайт и запрашиваем тестовые токены.");
    expect(p).toContain("не переписывай");
  });

  test("промпт отваживает от канального «отрабатываем»", () => {
    expect(activityPrompt(act(), [])).toContain("отрабатываем");
  });

  test("образцы для активностей берутся из активностей, а не из выпусков", () => {
    const manual = {
      digests: { d: good({ title: `ВЫПУСК ${good().title}` }) },
      activities: { a: okAct({ title: `КАРТОЧКА ${okAct().title}` }) },
    };
    const first = (e: EditorialEntry) => e.title.split(" ")[0];
    expect(styleExamples(manual, "activities").map(first)).toEqual(["КАРТОЧКА"]);
    expect(styleExamples(manual, "digests").map(first)).toEqual(["ВЫПУСК"]);
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
    const manual = { digests: { x: good({ title: `ОБРАЗЕЦ ЗАГОЛОВКА ${good().title}` }) } };
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

/**
 * Раскладка сайта менялась под работающей редактурой, и та этого не заметила:
 * корпус читался из `/opt/delabs/src`, которого после перехода на релизы больше
 * нет, а пустой результат выглядел как «всё уже отредактировано». Сутки выпуски
 * выходили текстом поста без единой ошибки в журнале.
 */
describe("раскладка сайта", () => {
  const tmp = mkdtempSync(join(tmpdir(), "editorial-tree-"));

  test("релизная раскладка: дерево за ссылкой current", () => {
    const root = join(tmp, "releases-layout");
    mkdirSync(join(root, "current", "src", "data"), { recursive: true });
    expect(siteTree(root)).toBe(join(root, "current"));
  });

  test("прежняя раскладка и рабочая копия на Mac: дерево в самом каталоге", () => {
    const root = join(tmp, "plain-layout");
    mkdirSync(join(root, "src", "data"), { recursive: true });
    expect(siteTree(root)).toBe(root);
  });

  test("пустой каталог — это не старая раскладка, а повод упасть на чтении", () => {
    const root = join(tmp, "empty-layout");
    mkdirSync(root, { recursive: true });
    expect(siteTree(root)).toBe(root);
    expect(() => readCorpus(join(root, "src/data/current/digests.json"))).toThrow(/нет корпуса/);
  });

  test("корпус на месте — читается как обычно", () => {
    const root = join(tmp, "ok-layout");
    const dir = join(root, "current", "src", "data", "current");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "digests.json"), JSON.stringify([{ id: "a" }]));
    expect(readCorpus(join(siteTree(root), "src/data/current/digests.json"))).toEqual([{ id: "a" }]);
  });
});

describe("норма длины — по выпускам, написанным руками (22.09.2026)", () => {
  test("выпуск в две строки не проходит: так выглядели сырые посты рядом с разбором", () => {
    const bad = checkEntry(
      good({ title: "CypherSquad проводит минт NFT на Zcash", summary: "Минт сегодня в 20:00.", body: "Проверяем доступ через чекер." }),
      digest(),
    );
    expect(bad.length).toBe(3);
  });

  test("тело одним сплошным абзацем не проходит", () => {
    expect(checkEntry(good({ body: "Абзац. ".repeat(90) }), digest()).join(" ")).toContain("одним абзацем");
  });

  test("слишком длинный лид отбраковывается так же, как короткий", () => {
    expect(checkEntry(good({ summary: "Деталь. ".repeat(60) }), digest()).join(" ")).toContain("лид");
  });

  test("в промпте обе границы лида и тела", () => {
    const p = editorialPrompt(digest(), []);
    expect(p).toContain(`${SUMMARY_MIN}-${SUMMARY_MAX}`);
    expect(p).toContain(`${BODY_MIN}-${BODY_MAX}`);
  });

  test("короткий образец не показываем: агент принял бы его за норму", () => {
    const manual = { digests: { short: good({ body: "Абзац.\n\nЕщё абзац." }) } };
    expect(styleExamples(manual)).toEqual([]);
  });

  test("повторная попытка получает причины отказа", () => {
    const note = retryNote(["лид 120 символов, нужно 180-340"]);
    expect(note).toContain("лид 120 символов");
    expect(note).toContain("JSON");
  });
});
