/**
 * Аудит 2026-08-20: футер-предикат вырезал живые CTA и заголовки пунктов.
 *
 * Правка 2026-08-19 потребовала «второго признака» рядом с ведущим 💬, но взяла
 * признаки, из которых живая CTA и состоит: ссылку и слова «чат»+«сообществ».
 * Плюс одиночное «активност» — а это заголовок ПУНКТА недельного поста.
 *
 * Цена ошибки высокая с обеих сторон:
 *  - `ensureChannelFooter` зовётся один раз, в PUBLISH_TO_CHANNEL, то есть уже
 *    ПОСЛЕ одобрения человеком: правится утверждённый текст, и увидеть это
 *    можно только на опубликованном посте;
 *  - `site-ingest` применяет тот же предикат к КАЖДОЙ строке, поэтому та же
 *    строка пропадает из items/summary карточки на сайте.
 *
 * Инвариант: футером считается только то, чего в живой CTA не бывает —
 * бренд-хвост 🤑, копирайт, либо каноническая ФОРМА целиком (оба блока через
 * `|`). Слабые признаки работают лишь внутри уже найденного блока.
 */
import { describe, test, expect } from "bun:test";
import {
  isChannelFooterLine,
  ensureChannelFooter,
  CHANNEL_FOOTER,
} from "../lib/channel-footer.ts";

const BODY = "🔥 **Новость дня**\n\nБиткоин снова вырос.";

describe("живая CTA остаётся в посте", () => {
  test("«обсуждаем в чате сообщества» — не футер", () => {
    expect(isChannelFooterLine("💬 Обсуждаем в чате сообщества")).toBe(false);
  });

  // Осознанно НЕ чиним: «💬 Вопросы — сюда: https://t.me/+abc» по содержанию
  // неотличима от рукописного футера «💬 Чат: https://t.me/delabs_chat», а его
  // замена каноническим блоком — решение аудита 2026-08-19 (см. тест
  // audit-2026-08-19-fixes.test.ts). Ссылка остаётся признаком футера.
  test("рукописный футер со ссылкой — по-прежнему футер", () => {
    expect(isChannelFooterLine("💬 Чат: https://t.me/delabs_chat")).toBe(true);
  });

  test("заголовок пункта «Активности недели» — не футер", () => {
    expect(isChannelFooterLine("💬 **Активности недели в Monad**")).toBe(false);
  });

  test("пост с CTA не меняется вовсе", () => {
    const post = `${BODY}\n\n💬 Обсуждаем в чате сообщества`;
    expect(ensureChannelFooter(post)).toBe(post);
  });

  test("заголовок пункта в теле переживает публикацию", () => {
    const post = ["**Итоги недели**", "", "💬 **Активности недели в Monad**", "", "Текст пункта."].join("\n");
    expect(ensureChannelFooter(post)).toBe(post);
  });
});

describe("настоящий футер по-прежнему заменяется", () => {
  test("канонический футер распознаётся", () => {
    expect(isChannelFooterLine(CHANNEL_FOOTER)).toBe(true);
  });

  test("рукописный футер без ссылок — каноническая форма через `|`", () => {
    expect(isChannelFooterLine("💬 ЧАТ сообщества | Активности")).toBe(true);
  });

  test("рукописный футер заменяется на канонический со ссылками", () => {
    const out = ensureChannelFooter(`${BODY}\n\n💬 ЧАТ сообщества | Активности`);
    expect(out).toContain("t.me/+TBw7");
    expect(out).toContain("Биткоин снова вырос.");
    expect(out.match(/💬/gu)?.length).toBe(1);
  });

  test("канонический футер не задваивается", () => {
    const out = ensureChannelFooter(`${BODY}\n\n${CHANNEL_FOOTER}`);
    expect(out.match(/Copyright/gu)?.length).toBe(1);
  });
});

describe("многострочный футер снимается целиком", () => {
  test("строка чата над копирайтом не выживает", () => {
    const out = ensureChannelFooter(`${BODY}\n\n💬 ЧАТ сообщества\n© Copyright 2023-2026 DeLabs`);
    // Ровно один 💬 — канонического футера. Иначе в канал уходит два
    // приглашения в чат (регресс, который чинил аудит 2026-08-12).
    expect(out.match(/💬/gu)?.length).toBe(1);
    expect(out.match(/Copyright/gu)?.length).toBe(1);
    expect(out).toContain("Биткоин снова вырос.");
  });

  test("пустая строка внутри блока не мешает", () => {
    const out = ensureChannelFooter(
      `${BODY}\n\n💬 ЧАТ сообщества\n\n© Copyright 2023-2026 DeLabs`,
    );
    expect(out.match(/💬/gu)?.length).toBe(1);
  });

  test("слабый признак НЕ тянет через тело поста", () => {
    // Между CTA и футером — обычный абзац. Цикл обязан остановиться на нём.
    const post = [
      "**Пост**",
      "",
      "💬 Обсуждаем в чате сообщества",
      "",
      "Ещё абзац текста.",
      "",
      "© Copyright 2023-2026 DeLabs",
    ].join("\n");
    const out = ensureChannelFooter(post);
    expect(out).toContain("💬 Обсуждаем в чате сообщества");
    expect(out).toContain("Ещё абзац текста.");
  });
});
