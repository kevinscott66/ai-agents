/**
 * Аудит 2026-08-11: мост «пост в канале → карточка на сайте» терял содержание
 * из-за слишком широкого определения футера.
 *
 * site-ingest.ts держал СВОЮ версию isFooterLine:
 *
 *     /💬|copyright|чат\s+сообщества|©|delabs/iu
 *
 * `delabs` без якоря матчит ЛЮБУЮ строку с названием бренда — а канал у нас
 * ровно про DeLabs, и бренд поминается в каждом втором абзаце. Такие строки
 * выбрасывались и из items, и из summary.
 *
 * Замер на реальном по форме дайджесте (3 ссылки, вступление со словом DeLabs):
 * items = 2 из 3 (пункт «Разбор от DeLabs: [как фармить Linea]» исчезал),
 * summary = дословный title, потому что вступление тоже вычистили и сработал
 * фолбэк `summary = title`. То есть на сайте карточка с заголовком вместо
 * описания и с недосчитанными источниками — ровно тот «однотипный, будто
 * сгенерированный» вид, на который жалуется владелец.
 *
 * Настоящий футер узнаётся иначе, и в action-dispatch.ts (там, где он и
 * ставится) определение всегда было строгим: `^💬`, `copyright`, `DeLabs🤑`,
 * `^©`. Две копии одного правила разъехались — теперь правило одно, в
 * lib/channel-footer.ts, и обе стороны берут его оттуда.
 */
import { describe, test, expect } from "bun:test";
import { parseDigestPost } from "../lib/site-ingest.ts";
import { ensureChannelFooter } from "../lib/action-dispatch.ts";
import { isChannelFooterLine, CHANNEL_FOOTER } from "../lib/channel-footer.ts";

const POST = `📰 **Итоги недели: аирдропы и тестнеты**

🗓️ 12 августа 2026

Команда DeLabs разобрала три активности недели.

• [Monad тестнет](https://testnet.monad.xyz) — фаза 2, задания на 5 минут
• Разбор от DeLabs: [как фармить Linea](https://linea.build/quests)
• [Scroll Sessions](https://scroll.io/sessions) — снапшот в сентябре

💬 [ЧАТ](https://t.me/+TBw7) сообщества | **© Copyright 2023-2026 [DeLabs](https://t.me/+GlWh)**🤑`;

describe("isChannelFooterLine: один источник правды", () => {
  test("строки настоящего футера — да", () => {
    for (const line of CHANNEL_FOOTER.split("\n")) {
      expect(isChannelFooterLine(line)).toBe(true);
    }
    expect(isChannelFooterLine("© 2026 DeLabs")).toBe(true);
    expect(isChannelFooterLine("**© Copyright 2023-2026 DeLabs**🤑")).toBe(true);
  });

  test("обычная строка с брендом — нет", () => {
    expect(isChannelFooterLine("Команда DeLabs разобрала три активности недели.")).toBe(false);
    expect(isChannelFooterLine("• Разбор от DeLabs: [как фармить Linea](https://linea.build/quests)")).toBe(false);
  });

  test("совпадает с тем, что реально снимает ensureChannelFooter", () => {
    // Если предикаты разъедутся снова, футер будет считаться то так, то эдак.
    const withFooter = `Текст поста.\n\n${CHANNEL_FOOTER}`;
    expect(ensureChannelFooter(withFooter)).toContain(CHANNEL_FOOTER);
    expect(ensureChannelFooter("Текст поста.")).toBe("Текст поста.");
  });
});

describe("parseDigestPost: бренд в тексте — не футер", () => {
  test("пункт со словом DeLabs не выбрасывается", () => {
    const r = parseDigestPost(POST);
    expect(r.items.length).toBe(3);
    expect(r.items.map((i) => i.url)).toContain("https://linea.build/quests");
    expect(r.sourceCount).toBe(3);
  });

  test("summary — вступление поста, а не копия заголовка", () => {
    const r = parseDigestPost(POST);
    expect(r.summary).not.toBe(r.title);
    expect(r.summary).toContain("три активности недели");
  });

  test("сам футер в карточку по-прежнему не попадает", () => {
    const r = parseDigestPost(POST);
    expect(r.summary).not.toContain("Copyright");
    expect(r.items.map((i) => i.url)).not.toContain("https://t.me/+GlWh");
  });
});
