/**
 * Аудит 2026-08-20: подпись к превью черновика ничем не ограничена.
 *
 * `main()` собирает `caption` из `buildPreviewText(articles)` + футер «ЧЕРНОВИК
 * на сегодня…» и отдаёт его в `client.sendFile({ caption })`. Потолок подписи к
 * ФОТО в Telegram — 1024 кодовых единицы, а не 4096: это записано в самом репо
 * дважды — в комментарии к `TG_MESSAGE_LIMIT` («не подписи к фото — та 1024») и
 * в `main()` над рассылкой полного текста («в подпись к фото он не влезает
 * (1024 символа)»).
 *
 * При этом обе половины подписи пишет модель и ни одна не обрезана: заголовок и
 * блёрб на каждую из четырёх (`.slice(0, 4)`) новостей. Инвариант «превью
 * короткое» держался только фикстурой из ДВУХ новостей с короткими блёрбами
 * (`daily-draft-approval-covers-body.test.ts`), то есть не держался ничем.
 *
 * Цена промаха несоразмерна: gramjs бросает, `catch` зовёт `fail(..., 1)`, и
 * день пропускается ЦЕЛИКОМ — уже после ресёрча на `RESEARCH_MAX_TURNS = 20`
 * ходов Agent SDK, за который заплачено.
 */
import { test, expect, describe } from "bun:test";
import { HTMLParser } from "telegram/extensions/html";
import {
  buildPreviewText,
  buildDraftCaption,
  DRAFT_CAPTION_FOOTER,
  TG_CAPTION_LIMIT,
  type DraftArticle,
} from "../tools/daily-draft.ts";
import { mdToUserbotHtml } from "../lib/telegram-format.ts";

function article(title: string, blurb: string, emoji: string): DraftArticle {
  return {
    title,
    date: "2026-08-20T00:00:00.000Z",
    summary: blurb,
    body: "Тело статьи, на подпись не влияет.",
    items: [{ text: "Источник", url: "https://example.com/x" }],
    sourceCount: 1,
    emoji,
    blurb,
  };
}

/**
 * Ровно то, что вернул бы ресёрч: четыре новости, заголовки и блёрбы — обычной
 * для модели длины (70–90 и 130–170 символов). Ничего патологического.
 */
const REAL: DraftArticle[] = [
  article(
    "Aave запускает обязательную оценку рисков для всех новых рынков v4",
    "Совет DAO утвердил регламент: ни один изолированный рынок не стартует без внешнего аудита параметров ликвидации и потолка заимствований.",
    "🔥",
  ),
  article(
    "SEC одобрила первый спотовый ETF на Solana с механизмом стейкинга",
    "Приток в первый день составил $292M — рекорд для альткоин-ETF, при этом эмитент получил право стейкать до 50% активов фонда.",
    "💰",
  ),
  article(
    "EigenLayer открывает вывод рестейкнутого ETH без периода ожидания",
    "Обновление убирает семидневную очередь для операторов, соблюдающих требования по децентрализации набора валидаторов.",
    "🌐",
  ),
  article(
    "Base переходит на собственный секвенсор с открытым набором участников",
    "Coinbase передаёт управление очередью транзакций пулу независимых операторов, первые пять уже прошли отбор и запускают ноды.",
    "😎",
  ),
];

/** Как подпись собиралась ДО фикса — превью плюс футер через пустую строку. */
function legacyCaption(articles: DraftArticle[]): string {
  return [buildPreviewText(articles), "", DRAFT_CAPTION_FOOTER].join("\n");
}

/** Ровно тот текст, что уходит в `sendFile({ caption })` после парсера. */
function wireText(caption: string): string {
  return HTMLParser.parse(mdToUserbotHtml(caption))[0] as string;
}

describe("подпись к превью черновика — потолок 1024", () => {
  test("реалистичный черновик на 4 новости в подпись НЕ влезал", () => {
    // Страховка от вырождения теста: если фикстура вдруг станет короткой,
    // остальные проверки пройдут вакуумно и дефект вернётся незамеченным.
    expect(legacyCaption(REAL).length).toBeGreaterThan(TG_CAPTION_LIMIT);
  });

  test("buildDraftCaption укладывается в лимит", () => {
    expect(buildDraftCaption(REAL).length).toBeLessThanOrEqual(TG_CAPTION_LIMIT);
  });

  test("в лимит укладывается и то, что реально уходит в sendFile", () => {
    expect(wireText(buildDraftCaption(REAL)).length).toBeLessThanOrEqual(
      TG_CAPTION_LIMIT,
    );
  });

  test("футер выживает дословно — без него апрувить нечем", () => {
    // Владелец одобряет реакцией именно на это сообщение; инструкция «✅ или
    // ответ "+"» — единственное место, где сказано, как это сделать.
    expect(buildDraftCaption(REAL)).toContain(DRAFT_CAPTION_FOOTER);
    expect(buildDraftCaption(REAL).endsWith(DRAFT_CAPTION_FOOTER)).toBe(true);
  });

  test("ни одна новость не пропадает из превью — ужимаются только блёрбы", () => {
    const caption = buildDraftCaption(REAL);
    for (const a of REAL) expect(caption).toContain(a.title);
  });

  test("короткий черновик не трогаем — подпись байт в байт прежняя", () => {
    const short = REAL.slice(0, 2).map((a) => ({ ...a, blurb: "Коротко." }));
    expect(buildDraftCaption(short)).toBe(legacyCaption(short));
  });

  test("патологический вход — заголовки по 400 символов — тоже влезает", () => {
    const huge = REAL.map((a) => ({
      ...a,
      title: a.title.repeat(8),
      blurb: (a.blurb ?? "").repeat(20),
    }));
    const caption = buildDraftCaption(huge);
    expect(caption.length).toBeLessThanOrEqual(TG_CAPTION_LIMIT);
    expect(caption.endsWith(DRAFT_CAPTION_FOOTER)).toBe(true);
  });

  test("обрезка не рвёт суррогатную пару", () => {
    // Эмодзи вне BMP занимает две кодовые единицы: срез между ними даёт два
    // одиноких суррогата, Telegram рисует «�» (та же причина, что у safeCut).
    const emo = REAL.map((a) => ({ ...a, blurb: "🔥".repeat(300) }));
    const caption = buildDraftCaption(emo);
    expect(caption.length).toBeLessThanOrEqual(TG_CAPTION_LIMIT);
    expect(/[\uD800-\uDBFF]/.test(caption.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
    expect(/[\uDC00-\uDFFF]/.test(caption.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  });

  test("лимит параметризуем — и соблюдается на маленьком", () => {
    const caption = buildDraftCaption(REAL, 400);
    expect(caption.length).toBeLessThanOrEqual(400);
    expect(caption.endsWith(DRAFT_CAPTION_FOOTER)).toBe(true);
  });

  test("пустой список статей не роняет сборку", () => {
    expect(() => buildDraftCaption([])).not.toThrow();
    expect(buildDraftCaption([]).endsWith(DRAFT_CAPTION_FOOTER)).toBe(true);
  });

  test("TG_CAPTION_LIMIT — это 1024, а не потолок обычного сообщения", () => {
    expect(TG_CAPTION_LIMIT).toBe(1024);
  });
});
