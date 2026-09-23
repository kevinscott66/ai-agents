/**
 * Публикация без апрува (23.09.2026, просьба владельца: «пускай он всё постит
 * сразу без апрува в таком же стиле, что и на сайте»).
 *
 * Гейт апрува снимается флагом окружения, а не правкой кода: это решение
 * владельца канала, и вернуть гейт нужно уметь строкой в
 * /opt/agent-team/.env, без выкладки. Поэтому по умолчанию (флага нет)
 * поведение остаётся прежним — публикует только явный апрув.
 *
 * Чего авто-режим НЕ отменяет: владелец успел ответить на превью текстом
 * «стоп» — пост не уходит. Всё остальное, включая молчание и нечитаемые
 * ответы, публикуется: «сразу» значит сразу.
 *
 * Отдельно здесь же закреплён лид пункта в канале. Раньше это был `blurb` —
 * первое предложение аннотации; владелец просил тот же объём, что на сайте,
 * поэтому в пост идёт `summary` целиком, а `blurb` остаётся запасным.
 */
import { describe, test, expect } from "bun:test";
import {
  autoPublishEnabled,
  decideAuto,
  isAutoPublishable,
  buildFinalText,
} from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

describe("флаг авто-публикации", () => {
  test("включается только явным значением", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(autoPublishEnabled({ DELABS_AUTO_PUBLISH: v })).toBe(true);
    }
  });

  test("по умолчанию выключен — гейт апрува на месте", () => {
    for (const v of [undefined, "", "0", "false", "no", "off", "может быть"]) {
      expect(autoPublishEnabled({ DELABS_AUTO_PUBLISH: v })).toBe(false);
    }
  });
});

describe("решение в авто-режиме", () => {
  test("молчание — публикуем (в обычном режиме это было «ждём»)", () => {
    expect(decideAuto({ reaction: false, replies: [] }).approved).toBe(true);
  });

  test("нечитаемые ответы публикацию не держат", () => {
    expect(decideAuto({ reaction: false, replies: null }).approved).toBe(true);
  });

  test("апрув словом или реакцией — тоже публикуем", () => {
    expect(decideAuto({ reaction: true, replies: [] }).approved).toBe(true);
    expect(decideAuto({ reaction: false, replies: ["+"] }).approved).toBe(true);
  });

  test("содержательный ответ владельца — вето, публикации нет", () => {
    const d = decideAuto({ reaction: true, replies: ["стоп, второй пункт переделать"] });
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("veto");
    expect(d.vetoText).toContain("стоп");
  });
});

describe("isAutoPublishable", () => {
  const client = (msgs: any[]) =>
    ({
      getInputEntity: async () => ({}),
      getMessages: async () => msgs,
    }) as any;

  test("превью без реакций и ответов — публикуем", async () => {
    expect(await isAutoPublishable(client([{}]), 42)).toBe(true);
  });

  test("ответ-вето на превью — не публикуем", async () => {
    const msgs = [{ replyTo: { replyToMsgId: 42 }, message: "не публикуй, тут ошибка" }];
    expect(await isAutoPublishable(client(msgs), 42)).toBe(false);
  });

  test("Telegram не ответил — публикуем, а не ждём", async () => {
    const broken = {
      getInputEntity: async () => {
        throw new Error("network");
      },
    } as any;
    expect(await isAutoPublishable(broken, 42)).toBe(true);
  });
});

describe("лид пункта в канальном посте", () => {
  const draft = (a: Record<string, unknown>): PendingDraft =>
    ({
      createdAt: "2026-09-23T08:00:00.000Z",
      previewMsgId: 1,
      dayTitle: "Дайджест: проверка лида",
      articles: [
        {
          title: "Заголовок новости",
          date: "2026-09-23",
          summary: "Первое предложение аннотации. Второе предложение с цифрой 42.",
          body: "тело",
          items: [],
          sourceCount: 1,
          ...a,
        },
      ],
    }) as PendingDraft;

  test("в пост идёт вся аннотация, а не только первое предложение", () => {
    const text = buildFinalText(draft({ blurb: "Первое предложение аннотации." }));
    expect(text).toContain("Второе предложение с цифрой 42.");
  });

  test("без summary остаётся blurb", () => {
    const text = buildFinalText(draft({ summary: "", blurb: "Запасной лид." }));
    expect(text).toContain("Запасной лид.");
  });
});
