/**
 * Аудит 2026-08-28: футер снова ел содержимое уже одобренного поста.
 *
 * Два независимых дефекта в `channel-footer.ts`, оба на пути публикации в
 * @delabsru, оба после апрува человеком:
 *
 * 1) В класс ведущего оформления копирайт-регулярки были дописаны маркеры
 *    списка (`•`, `·`, `—`, `-`) — ровно те глифы, с которых начинаются
 *    ПУНКТЫ дайджеста. «• Copyright 2024 спор в Zora закрыт мировым
 *    соглашением.» считалось футером, и последний пункт вырывался из поста, а
 *    заодно из карточки на delabs.space: `site-ingest.ts` переиспользует ту же
 *    функцию как `isFooterLine`.
 *
 * 2) Потолок подъёма по слабому признаку был флагом «в блоке уже встречался
 *    💬». `approve-poll.ts:632` приклеивает канонический футер ЗАРАНЕЕ, тот
 *    снимается первой итерацией и поднимает флаг — рукописный многострочный
 *    футер над ним замораживается, и в канал уходит два приглашения в чат.
 *    Тот же вход без предварительной склейки обрабатывался верно, поэтому
 *    прежние тесты этого не видели.
 */
import { describe, expect, test } from "bun:test";
import {
  CHANNEL_FOOTER,
  ensureChannelFooter,
  isChannelFooterLine,
} from "../lib/channel-footer.ts";

const BODY = "📰 **Дайджест**\n\nКоротко о главном.";

describe("маркер списка не делает строку футером", () => {
  test("пункт дайджеста со словом copyright и годом остаётся пунктом", () => {
    for (const bullet of ["•", "·", "—", "-", "–", "*·"]) {
      const line = `${bullet} Copyright 2024: спор в Zora закрыт мировым соглашением.`;
      expect([bullet, isChannelFooterLine(line)]).toEqual([bullet, false]);
    }
  });

  test("такой пункт не вырывается из поста", () => {
    const post = `${BODY}\n\n• Copyright 2024 спор в Zora закрыт мировым соглашением.`;
    expect(ensureChannelFooter(post)).toBe(post);
  });

  test("© copyright и copyright © с маркером списка — тоже пункт", () => {
    expect(isChannelFooterLine("• © Copyright спор закрыт")).toBe(false);
    expect(isChannelFooterLine("— Copyright © дело закрыто")).toBe(false);
  });

  test("выделение по-прежнему пропускается: жирный копирайт это футер", () => {
    expect(isChannelFooterLine("**© Copyright 2023-2026 DeLabs**🤑")).toBe(true);
    expect(isChannelFooterLine("__Copyright 2024 DeLabs__")).toBe(true);
    expect(isChannelFooterLine("~~© Copyright 2026~~")).toBe(true);
  });

  test("копирайт в начале строки без оформления — футер, как и был", () => {
    expect(isChannelFooterLine("© Copyright 2023-2026 DeLabs")).toBe(true);
    expect(isChannelFooterLine("  Copyright 2024 DeLabs")).toBe(true);
  });
});

describe("заранее приклеенный канонический футер", () => {
  // Форма вызова из tools/approve-poll.ts:632.
  const prepended = (text: string) => ensureChannelFooter(`${text}\n\n${CHANNEL_FOOTER}`);

  test("рукописный многострочный футер под ним снимается целиком", () => {
    const out = prepended("Итоги недели.\n\n💬 ЧАТ сообщества\n© Copyright 2023-2026 DeLabs");
    expect(out).toBe(`Итоги недели.\n\n${CHANNEL_FOOTER}`);
  });

  test("ровно одно приглашение в чат и один копирайт", () => {
    const out = prepended("Итоги недели.\n\n💬 ЧАТ сообщества\n© Copyright 2023-2026 DeLabs");
    expect(out.match(/💬/gu)?.length).toBe(1);
    expect(out.match(/Copyright/gu)?.length).toBe(1);
  });

  test("живая CTA под приклеенным футером по-прежнему выживает", () => {
    // Потолок никуда не делся: 💬 стоит НЕПОСРЕДСТВЕННО под CTA.
    const out = prepended("Тело поста.\n\n💬 Что думаете? Пишем в чате сообщества");
    expect(out).toContain("Что думаете");
    expect(out.endsWith(CHANNEL_FOOTER)).toBe(true);
    expect(out.match(/💬/gu)?.length).toBe(2);
  });

  test("текст без своего футера просто получает канонический", () => {
    expect(prepended("Итоги недели.")).toBe(`Итоги недели.\n\n${CHANNEL_FOOTER}`);
  });

  test("пункт дайджеста с copyright переживает и этот путь", () => {
    const out = prepended("📰 Итоги\n\n• Copyright 2024 спор в Zora закрыт.");
    expect(out).toContain("• Copyright 2024 спор в Zora закрыт.");
  });
});

describe("пост, от которого остался один футер", () => {
  test("канонический футер сам по себе не обрастает пустой строкой", () => {
    expect(ensureChannelFooter(CHANNEL_FOOTER)).toBe(CHANNEL_FOOTER);
  });

  test("рукописный футер без тела заменяется без ведущего отступа", () => {
    expect(ensureChannelFooter("💬 ЧАТ сообщества | Активности")).toBe(CHANNEL_FOOTER);
  });
});

describe("что не должно измениться", () => {
  test("многострочный футер модели без предварительной склейки", () => {
    const out = ensureChannelFooter(`${BODY}\n\n💬 ЧАТ сообщества\n© Copyright 2023-2026 DeLabs`);
    expect(out).toBe(`${BODY}\n\n${CHANNEL_FOOTER}`);
  });

  test("слабый признак не тянет через тело поста", () => {
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

  test("пост без футера не трогается", () => {
    expect(ensureChannelFooter(BODY)).toBe(BODY);
  });
});
