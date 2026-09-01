/**
 * Аудит 2026-08-12: слово «copyright» в теле поста считалось футером — строка
 * молча пропадала.
 *
 * Правило было:
 *   /^\s*💬|copyright|DeLabs🤑|^\s*©/iu
 * Якорь `^\s*` в альтернации относится ТОЛЬКО к 💬 и к ©. `copyright` матчил в
 * любой позиции строки, регистронезависимо — при том что комментарий двумя
 * строками выше утверждает обратное: «Маркеры намеренно узкие… "copyright" и
 * "DeLabs🤑" — как часть копирайт-строки».
 *
 * Это ровно тот дефект, который в этом же файле уже чинили для `delabs`
 * (см. шапку модуля): маркер без контекста ловит содержательный текст.
 *
 * Два потребителя, оба теряют контент:
 *  1) ensureChannelFooter отрывает хвостовые строки, пока они «футерные», и по
 *     флагу removed приклеивает канонический футер. Пост, кончающийся строкой
 *     «• Спор про copyright в Zora закрыт», терял этот пункт И получал футер,
 *     которого в нём не было.
 *  2) site-ingest применяет тот же предикат к КАЖДОЙ строке поста — такая
 *     строка выпадает из items и summary карточки на delabs.space.
 *
 * Инвариант: «copyright» — маркер футера только вместе с © или годом, то есть
 * когда это действительно копирайт-строка. Само по себе слово — обычный текст.
 */
import { describe, test, expect } from "bun:test";
import { isChannelFooterLine, ensureChannelFooter } from "../lib/channel-footer.ts";

describe("copyright в теле поста — не футер", () => {
  test("содержательная строка со словом copyright остаётся", () => {
    expect(isChannelFooterLine("• Спор про copyright в Zora закрыт")).toBe(false);
    expect(isChannelFooterLine("Разбираем copyright на генеративный арт")).toBe(false);
    expect(isChannelFooterLine("🔹 [DMCA и copyright](https://x.dev) — что изменилось")).toBe(
      false,
    );
  });

  test("пост не теряет последний пункт и не получает чужой футер", () => {
    const post = [
      "**Дайджест**",
      "",
      "• Пункт один",
      "• Спор про copyright в Zora закрыт",
    ].join("\n");
    const out = ensureChannelFooter(post);
    expect(out).toContain("Спор про copyright в Zora закрыт");
    // Футера в исходнике не было — навязывать его нельзя.
    expect(out).toBe(post);
  });
});

describe("настоящая копирайт-строка по-прежнему футер", () => {
  test("канонические и рукописные варианты", () => {
    for (const line of [
      "💬 [ЧАТ](https://t.me/x) сообщества | **© Copyright 2023-2026 [DeLabs](https://t.me/y)**🤑",
      "**© Copyright 2023-2026 DeLabs**🤑",
      "© Copyright 2023-2026 DeLabs",
      "Copyright 2023-2026 DeLabs",
      "Активности DeLabs🤑",
    ]) {
      expect(isChannelFooterLine(line)).toBe(true);
    }
  });

  // Аудит 2026-08-20: «💬 ЧАТ сообщества» отдельной строкой из этого списка
  // убрано намеренно. По содержанию она неотличима от живой CTA («💬 Обсуждаем
  // в чате сообщества»), а предикат применяется и построчно в site-ingest —
  // то есть цена ошибки здесь равна потере строки тела поста. Футером она
  // считается только В КОНТЕКСТЕ блока: настоящая футерная строка ниже.
  test("строка чата сама по себе не футер, но в блоке — футер", () => {
    expect(isChannelFooterLine("  💬 ЧАТ сообщества")).toBe(false);

    const text = "Пост.\n\n💬 ЧАТ сообщества\n© Copyright 2023-2026 DeLabs";
    const out = ensureChannelFooter(text);
    // Обе строки блока сняты, приглашение в чат не задвоилось.
    expect(out.match(/💬/gu)?.length).toBe(1);
    expect(out).toContain("t.me/+TBw7");
  });

  test("написанный агентом футер заменяется каноническим ровно один раз", () => {
    const text = "Пост.\n\n💬 ЧАТ сообщества | Активности © Copyright 2023-2026 DeLabs🤑";
    const out = ensureChannelFooter(text);
    expect(out.match(/Copyright/g)?.length).toBe(1);
    expect(out).toContain("t.me/+TBw7");
  });
});
