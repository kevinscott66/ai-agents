// Аудит 2026-08-20: PUBLISH_TO_CHANNEL предлагал 💬 как эмодзи ПУНКТА, а
// `isChannelFooterLine` считает 💬 в начале строки маркером футера.
//
// Пересечение стоило пункта на публичной карточке. Замер до правки, чистым
// `parseDigestPost` (без сети):
//
//   "**Итоги**\n\nВводный абзац.\n💬 **Discord-анонс:** … [пруф](t.me/…)"
//     -> items = [], sourceCount = 0
//   та же строка с 🔥 вместо 💬
//     -> items = 1, sourceCount = 1
//
// Отличить такую строку от рукописного футера «💬 Чат: https://t.me/…» ни по
// содержимому, ни по позиции нельзя — аудиты 2026-08-19 и PR #512 это уже
// разобрали и оставили как осознанную границу. Чинится причина: 💬
// зарезервирован под футер, и предлагать его для пунктов нельзя.
//
// Тест поведенческий, а не про текст промпта: набор эмодзи вынимается из
// самого описания инструмента и прогоняется через настоящий предикат. Вернут
// 💬 в список — тест упадёт, где бы список ни лежал.
import { test, expect, describe } from "bun:test";
import { TOOLS } from "../lib/tools-schema.ts";
import { isChannelFooterLine } from "../lib/channel-footer.ts";
import { parseDigestPost } from "../lib/site-ingest.ts";

const publish = TOOLS.find((t) => t.name === "PUBLISH_TO_CHANNEL");
const desc = String(publish?.description ?? "");

/** Эмодзи, которые описание предлагает ставить в пунктах поста. */
function advertisedItemEmoji(): string[] {
  const m = desc.match(/просто ставь обычные эмодзи \(([^)]+)\)/u);
  if (!m) return [];
  return [...m[1]!].filter((ch) => ch !== "️" && ch.trim() !== "");
}

describe("аудит 2026-08-20: эмодзи пункта не должен быть маркером футера", () => {
  test("описание PUBLISH_TO_CHANNEL найдено и список непустой", () => {
    expect(publish).toBeDefined();
    expect(advertisedItemEmoji().length).toBeGreaterThan(5);
  });

  test("ни один предложенный эмодзи не делает строку футером", () => {
    const bad = advertisedItemEmoji().filter((e) =>
      isChannelFooterLine(`${e} **Пункт:** текст — [пруф](https://t.me/x/1)`),
    );
    expect(bad).toEqual([]);
  });

  test("ни один предложенный эмодзи не роняет пункт с карточки сайта", () => {
    const lost = advertisedItemEmoji().filter(
      (e) =>
        parseDigestPost(`**Итоги**\n\nВводный абзац.\n${e} Пункт — [пруф](https://t.me/x/1)`)
          .items.length !== 1,
    );
    expect(lost).toEqual([]);
  });

  test("футер по-прежнему размечается через 💬 — это отдельная инструкция", () => {
    expect(desc).toContain("ФУТЕР:");
    expect(desc).toMatch(/ФУТЕР:[^\n]*💬/u);
  });

  // Контроль: сам предикат не ослаблен — 💬 остаётся маркером футера.
  test("💬-строка футера по-прежнему распознаётся", () => {
    expect(
      isChannelFooterLine("💬 ЧАТ сообщества | Активности © Copyright 2023-2026 DeLabs🤑"),
    ).toBe(true);
  });
});
