/**
 * Аудит 2026-08-20: заголовок публичной страницы брался из копирайта.
 *
 * `deriveTitle` (`lib/site-ingest.ts`) искал первый `**bold**` по ВСЕМУ тексту
 * поста. Фолбэк тремя строками ниже футер отфильтровывает явно
 * (`!isFooterLine(l)`), ветка с bold — нет. А футер у нас программный:
 * `ensureChannelFooter` (`action-dispatch.ts`) приклеивает канонический
 * `CHANNEL_FOOTER`, который заканчивается на
 * `**© Copyright 2023-2026 [DeLabs](…)**`. Подставляется он не безусловно —
 * `ensureChannelFooter` выходит через `if (!removed) return text`, если футера
 * в посте не было вовсе, — но написать пост без футера агенту нечем: футер
 * прописан в промпте, и канал так выглядит весь. То есть на любом посте
 * обычного вида bold есть, даже когда сам агент не выделил ничего.
 *
 * Результат для поста без своего bold (замер до правки):
 *
 *   title: "Copyright 2023-2026 [DeLabs](https://t.me/+GlWhq7pcZFkNjc6)"
 *
 * Это не косметика: все четыре выхода PUBLISH_TO_CHANNEL зовут
 * `ingestDigestToSite(fullText, …)` (`action-dispatch.ts:669,733,741,763`),
 * страница уходит на delabs.space вместе с записью в RSS, и снять её обратно
 * нельзя — ровно класс инцидента T-743.
 *
 * Ссылка в таком заголовке вдобавок битая: `MD_PUNCT_RE` съедает `_` из хеша
 * инвайта.
 *
 * Тест работает только с чистой `parseDigestPost` — наружу не ходит.
 */
import { describe, test, expect } from "bun:test";
import { parseDigestPost } from "../lib/site-ingest.ts";
import { CHANNEL_FOOTER } from "../lib/channel-footer.ts";
import { ensureChannelFooter } from "../lib/action-dispatch.ts";

/** Пост в том виде, в каком его получает мост: с уже приклеенным футером. */
function withFooter(...body: string[]): string {
  return [...body, "", CHANNEL_FOOTER].join("\n");
}

describe("заголовок страницы не берётся из футера", () => {
  test("сквозь настоящий ensureChannelFooter, а не приклеенную константу", () => {
    // Тесты выше склеивают CHANNEL_FOOTER руками. Это удобно, но проверяет
    // только парсер: если футер однажды перестанет подставляться (или начнёт
    // подставляться иначе), они этого не заметят и продолжат «доказывать»
    // защиту от текста, которого в посте уже нет. Здесь проходим тем же путём,
    // что и прод: агент пишет футер своими словами -> ensureChannelFooter
    // заменяет каноническим -> parseDigestPost.
    //
    // Форма фикстуры — два блока через `|` — не случайная. `ensureChannelFooter`
    // ничего не приклеивает, если футера не нашёл (`if (!removed) return text`),
    // так что фикстура обязана быть тем, что признаётся футером. Голое
    // «💬 наш чат сообщества» под это больше не подходит: PR #512 сузил признак
    // до канонической ФОРМЫ ровно потому, что заголовок пункта в теле поста
    // («💬 **Активности недели в Monad**») принимался за футер и вырезался.
    // Здесь же — футер, переписанный агентом простым текстом с потерей ссылок:
    // случай, ради которого `ensureChannelFooter` и существует.
    const posted = ensureChannelFooter(
      ["Свежие ссылки недели", "", "[Zora](https://zora.co/mint)", "", "💬 чат сообщества | Активности"].join(
        "\n",
      ),
    );
    expect(posted).toContain(CHANNEL_FOOTER); // фикстура честная, а не выдуманная
    expect(posted).toContain("**© Copyright"); // жирное в футере на месте

    const d = parseDigestPost(posted);
    expect(d.title.toLowerCase()).not.toContain("copyright");
    expect(d.title).not.toContain("t.me/");
    expect(d.title).toBe("Свежие ссылки недели");
    expect(d.items.length).toBe(1);
  });

  test("пост без своего bold: заголовок из текста, а не из копирайта", () => {
    const d = parseDigestPost(
      withFooter(
        "📰 Дайджест DeLabs",
        "🗓️ 20 августа 2026",
        "",
        "Собрали главное за день, без воды.",
        "",
        "🔥 Monad открыл вторую фазу тестнета — [Подробнее →](https://example.com/monad)",
      ),
    );
    expect(d.title.toLowerCase()).not.toContain("copyright");
    expect(d.title).not.toContain("t.me/");
    expect(d.title).toBe("Дайджест DeLabs");
  });

  test("совсем голый пост: футер не становится заголовком", () => {
    const d = parseDigestPost(
      withFooter("Что было на неделе в Web3 — коротко", "[тут](https://example.com/w)"),
    );
    expect(d.title.toLowerCase()).not.toContain("copyright");
    expect(d.title).toBe("Что было на неделе в Web3 — коротко");
  });

  test("свой bold в теле по-прежнему выигрывает у футера", () => {
    const d = parseDigestPost(
      withFooter(
        "🗓️ 20 августа 2026",
        "**Дайджест Web3 за 20 августа**",
        "",
        "Коротко о главном.",
        "[ссылка](https://example.com/a)",
      ),
    );
    expect(d.title).toBe("Дайджест Web3 за 20 августа");
  });

  test("первый bold тела выигрывает у второго — порядок не сломан", () => {
    const d = parseDigestPost(
      withFooter("**Первый**", "**Второй**", "[ссылка](https://example.com/a)"),
    );
    expect(d.title).toBe("Первый");
  });

  test("остальная карточка не пострадала: summary и источники на месте", () => {
    const d = parseDigestPost(
      withFooter(
        "📰 Дайджест DeLabs",
        "",
        "Собрали главное за день, без воды.",
        "",
        "🔥 Monad — [Подробнее →](https://example.com/monad)",
        "⚡ Base — [Гайд →](https://example.com/base)",
      ),
    );
    expect(d.summary).toBe("Собрали главное за день, без воды.");
    expect(d.sourceCount).toBe(2);
    expect(d.items.map((i) => i.url)).toEqual([
      "https://example.com/monad",
      "https://example.com/base",
    ]);
  });

  test("порог значимости строки пережил переписывание фолбэка", () => {
    // Пустая строка и огрызок в начале не должны становиться заголовком:
    // фолбэк требует >= 6 буквенно-цифровых символов. Ветку переписывали
    // вместе с bold — пусть порог держит тест, а не память.
    const d = parseDigestPost(withFooter("", "—", "Итоги недели по активностям"));
    expect(d.title).toBe("Итоги недели по активностям");
  });

  test("пост вообще без текста всё ещё даёт дефолт, а не копирайт", () => {
    const d = parseDigestPost(CHANNEL_FOOTER);
    expect(d.title).toBe("Дайджест");
  });
});
