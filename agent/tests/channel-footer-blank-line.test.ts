/**
 * Аудит 2026-08-12: футер приезжал в канал дважды, если между его двумя
 * строками стояла пустая.
 *
 * Цикл срезания останавливался на первой не-футерной строке:
 *
 *   while (lines.length && isChannelFooterLine(lines.at(-1))) { lines.pop(); removed = true; }
 *   if (!removed) return text;
 *
 * Пустая строка между «💬 ЧАТ …» и «© Copyright …» — обычная разметка от
 * модели — обрывала цикл после первой же итерации. Но `removed` уже true,
 * поэтому канонический футер приклеивался поверх уцелевшей строки «💬 ЧАТ»,
 * и в публичный канал уходили две строки-приглашения в чат.
 *
 * Вызов один: `ensureChannelFooter(p.text)` в PUBLISH_TO_CHANNEL, то есть уже
 * ПОСЛЕ одобрения человеком. Человек утверждает то, что написала модель;
 * дубль появляется на шаг позже и виден только когда пост уже опубликован.
 *
 * Существующие тесты этого не ловили: channel-footer.test.ts и остальные
 * (channel-footer-copyright, publish-to-channel, publish-fit-to-limit,
 * site-ingest-footer) используют слитный двухстрочный футер.
 */
import { describe, test, expect } from "bun:test";
import {
  ensureChannelFooter,
  CHANNEL_FOOTER,
  isChannelFooterLine,
} from "../lib/channel-footer.ts";

/** Сколько раз в тексте встречается приглашение в чат — маркер дубля. */
function chatInvites(s: string): number {
  return s.split("\n").filter((l) => /^\s*💬/u.test(l)).length;
}

describe("футер с пустой строкой внутри блока", () => {
  const BODY = "🔥 Главное за неделю\n\n• Пункт один";

  test("пустая строка между строками футера не оставляет половину футера", () => {
    const input = `${BODY}\n\n💬 ЧАТ сообщества | Активности\n\n© Copyright 2023-2026 DeLabs🤑`;
    const out = ensureChannelFooter(input);
    expect(chatInvites(out)).toBe(1);
    expect(out).toBe(`${BODY}\n\n${CHANNEL_FOOTER}`);
  });

  test("несколько пустых строк внутри блока — тот же результат", () => {
    const input = `${BODY}\n\n💬 ЧАТ сообщества\n\n\n© Copyright 2023-2026 DeLabs🤑`;
    expect(ensureChannelFooter(input)).toBe(`${BODY}\n\n${CHANNEL_FOOTER}`);
  });

  test("слитный футер по-прежнему заменяется целиком", () => {
    const input = `${BODY}\n\n💬 ЧАТ сообщества | Активности\n© Copyright 2023-2026 DeLabs🤑`;
    expect(ensureChannelFooter(input)).toBe(`${BODY}\n\n${CHANNEL_FOOTER}`);
  });

  test("пустая строка не даёт съесть текст поста", () => {
    // Обратная сторона: «пропускать пустые» не должно означать «идти дальше
    // сквозь них до любой футерной строки где-то выше».
    const input = "💬 обсудим в чате — там уже есть тред\n\n• Пункт один\n\n© Copyright 2023-2026 DeLabs🤑";
    const out = ensureChannelFooter(input);
    expect(out).toContain("• Пункт один");
    expect(out).toEndWith(CHANNEL_FOOTER);
  });

  test("текста без футера не касаемся", () => {
    const plain = `${BODY}\n\n• Пункт два`;
    expect(ensureChannelFooter(plain)).toBe(plain);
  });

  test("маркеры остались узкими", () => {
    // Регрессия к прежней починке: слово copyright само по себе — не футер.
    expect(isChannelFooterLine("• Спор про copyright в Zora закрыт")).toBe(false);
    expect(isChannelFooterLine("© Copyright 2023-2026 DeLabs🤑")).toBe(true);
  });
});
