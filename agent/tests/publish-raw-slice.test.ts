/**
 * Аудит 2026-08-12: пост терял хвост и футер ещё до того, как его кто-то мерил.
 *
 * Под лимит Telegram пост подгоняет ровно одно место — `fitToLimit` в
 * action-dispatch. Оно делает это правильно: ПОСЛЕ подстановки канонического
 * футера, по PLAIN-длине (то есть после markdown → HTML), целыми блоками, с
 * сохранением футера и с предупреждением в лог. Комментарий рядом с ним
 * (аудит 2026-08-04) прямо формулирует правило: «лимит должен проверяться на
 * том тексте, который реально уходит в Telegram, а не на промежуточном».
 *
 * Но в build-payload.ts стояла вторая обрезка, ВЫШЕ по потоку и грубее:
 * `text.slice(0, 4096)` по СЫРОМУ markdown. Сырая длина всегда больше plain —
 * `**жирный**`, `[текст](url)` в сообщение не уезжают. Значит пост, который в
 * одно сообщение помещался с запасом, обрезался, не дойдя до того, кто умеет
 * резать.
 *
 * Замер до правки на посте со ссылками: сырых 4860 → plain 2504 (лимит 4096,
 * запас 1592 символа). После `slice(0, 4096)`: plain 2160, футер «Подписывайтесь
 * на канал» исчез целиком, а текст оборвался ВНУТРИ `[текст](https://…` —
 * незакрытая markdown-ссылка уходит в mdToTelegramHtml и ломает разметку всего
 * поста. `fitToLimit` при этом не срабатывал вовсе: 2160 ≤ 4096, резать нечего.
 *
 * Молча: buildPayload возвращает ok, лога нет, модель об урезанном посте не
 * узнаёт. Это тот же класс, что три предыдущих фикса на этом пути (пост из
 * одного абзаца, футер-абзац, потерянная публикация) — с той разницей, что
 * здесь терялся не весь пост, а его конец.
 *
 * Инвариант: build-payload текст поста не режет. Он либо пропускает его целиком
 * дальше, к единственному месту с лимитом, либо отказывает явно — но не
 * подменяет пост его началом.
 */
import { describe, test, expect } from "bun:test";
import { buildPayload, PUBLISH_TEXT_MAX_RAW } from "../lib/dispatch/build-payload.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

const CTX = { agentKey: "smm" };

function build(text: string) {
  return buildPayload("PUBLISH_TO_CHANNEL", { channelId: -100777, text }, CTX as any);
}

/** Пост со ссылками: сырой markdown заметно длиннее того, что увидит читатель. */
function linkHeavyPost(paragraphs: number): string {
  const link =
    "[смотреть подробности здесь](https://delabs.example.org/articles/2026/08/airdrop-guide-for-beginners-part-two)";
  const para = `Текст абзаца про ретродроп. ${link} Ещё немного текста для объёма.`;
  return (
    "**Итоги недели**\n\n" +
    Array.from({ length: paragraphs }, () => para).join("\n\n") +
    "\n\n🔥 Подписывайтесь на канал"
  );
}

describe("текст поста не режется по сырой длине", () => {
  test("пост со ссылками доходит до лимита целиком", () => {
    const text = linkHeavyPost(28);
    // Предпосылка: сырой длиннее 4096, а plain — заметно короче лимита.
    expect(text.length).toBeGreaterThan(4096);
    expect(plainTelegramLength(text)).toBeLessThan(4096);

    const r = build(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.text).toBe(text);
  });

  test("футер и хвост не пропадают", () => {
    const text = linkHeavyPost(28);
    const r = build(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.text).toContain("Подписывайтесь на канал");
    expect(plainTelegramLength(r.payload.text)).toBe(plainTelegramLength(text));
  });

  test("разметка не обрывается на середине ссылки", () => {
    const text = linkHeavyPost(28);
    const r = build(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Число открывающих `](` и закрывающих `)` у ссылок должно сойтись:
    // обрезка по сырой длине оставляла незакрытую ссылку.
    const opens = (r.payload.text.match(/\]\(https/g) ?? []).length;
    const closes = (r.payload.text.match(/\]\(https[^)\s]*\)/g) ?? []).length;
    expect(closes).toBe(opens);
  });
});

describe("абсурдно длинный пост — отказ, а не молчаливый огрызок", () => {
  test("выше жёсткой границы buildPayload отказывает с внятным текстом", () => {
    const r = build("а".repeat(PUBLISH_TEXT_MAX_RAW + 1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("text");
    expect(r.error).toContain(String(PUBLISH_TEXT_MAX_RAW));
  });

  test("ровно на границе — пропускаем", () => {
    const r = build("а".repeat(PUBLISH_TEXT_MAX_RAW));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.text.length).toBe(PUBLISH_TEXT_MAX_RAW);
  });

  test("граница заведомо выше любого настоящего поста", () => {
    // 4096 — лимит сообщения; граница здесь только чтобы payload не распухал.
    expect(PUBLISH_TEXT_MAX_RAW).toBeGreaterThan(4096 * 4);
  });
});

describe("короткий пост не трогаем", () => {
  test("текст доезжает байт в байт", () => {
    const text = "**Крючок.** Живой пост.\n\n🔥 Подписывайтесь";
    const r = build(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.text).toBe(text);
  });
});
