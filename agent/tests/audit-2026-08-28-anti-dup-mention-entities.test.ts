/**
 * Аудит 2026-08-28: «упоминание» у роутинга и у анти-дупа значило разное.
 *
 * Доставка сообщения роли решается по сущностям Telegram — `isMentioned`
 * (`orchestrator/helpers.ts`) читает только `entity.type === "mention"`.
 * А `shouldAllowTools` искала чужой хэндл голым поиском подстроки по тексту.
 *
 * Совпадают эти два определения не всегда: хэндл внутри `code`-спана, внутри
 * ссылки или приклеенный к слову слева (`mail@dlb_design_bot`) сущностью
 * `mention` НЕ размечается. Роутинг такое сообщение дизайнеру не отдаёт —
 * а оркестратор всё равно оставался без инструментов и отвечал текстом.
 * Ход при этом уходил в никуда: делать работу больше некому.
 *
 * Чинится сведением к одному источнику правды: если разметка Telegram есть,
 * она и решает; поиск подстроки остаётся запасным путём (у вызова может не
 * быть сообщения вовсе) и тоже получает границу слева.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChatRow } from "../lib/db.ts";
import type { RunningBot } from "../lib/types.ts";
import { shouldAllowTools } from "../lib/anti-dup.ts";
import { mentionedHandles } from "../orchestrator/helpers.ts";

function fakeBot(key: string, username: string, id: number): RunningBot {
  return { def: { key } as any, bot: {} as any, username, id };
}

const BOTS: RunningBot[] = [
  fakeBot("orchestrator", "dlb_lead_bot", 1),
  fakeBot("design", "dlb_design_bot", 2),
];
const LEAD = { key: "orchestrator" } as const;
const NO_HISTORY: ChatRow[] = [];

const HANDLER_SRC = readFileSync(
  new URL("../orchestrator/message-handler.ts", import.meta.url),
  "utf-8",
);

describe("решает разметка Telegram, а не поиск подстроки", () => {
  test("хэндл в code-спане инструментов не отнимает", () => {
    // Telegram размечает такой кусок как `code`; сущности `mention` нет,
    // значит и дизайнеру сообщение не уедет.
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "запиши в вики строку `@dlb_design_bot — баннеры` и обнови индекс",
        BOTS,
        [],
      ),
    ).toBe(true);
  });

  test("хэндл внутри ссылки инструментов не отнимает", () => {
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "проверь https://example.test/@dlb_design_bot/status",
        BOTS,
        [],
      ),
    ).toBe(true);
  });

  test("размеченное упоминание глушит, как и раньше", () => {
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "@dlb_design_bot сделай баннер",
        BOTS,
        ["@dlb_design_bot"],
      ),
    ).toBe(false);
  });

  test("регистр в разметке не важен", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "@DLB_Design_Bot баннер", BOTS, [
        "@DLB_Design_Bot",
      ]),
    ).toBe(false);
  });

  test("свой хэндл в разметке важнее чужого", () => {
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "@dlb_lead_bot собери релиз: баннер от @dlb_design_bot",
        BOTS,
        ["@dlb_lead_bot", "@dlb_design_bot"],
      ),
    ).toBe(true);
  });

  test("чужой размеченный хэндл, которого нет среди наших ботов, не глушит", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "@someone_else глянь", BOTS, [
        "@someone_else",
      ]),
    ).toBe(true);
  });
});

describe("без разметки поведение прежнее", () => {
  test("подстрочный путь по-прежнему глушит на настоящем упоминании", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "это к @dlb_design_bot", BOTS),
    ).toBe(false);
  });

  test("хэндл-префикс чужого бота не глушит", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "что там у @dlb_design_bot_v2", BOTS),
    ).toBe(true);
  });

  test("граница слева: приклеенный к слову хэндл — не упоминание", () => {
    // Telegram такое `mention`-сущностью не размечает, и правая граница
    // (проверялась и раньше) здесь не спасает.
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "пиши на mail@dlb_design_bot", BOTS),
    ).toBe(true);
  });
});

describe("mentionedHandles", () => {
  test("возвращает только сущности mention, в нижнем регистре", () => {
    const ctx: any = {
      message: {
        text: "@DLB_Design_Bot глянь `@dlb_smm_bot`",
        entities: [
          { type: "mention", offset: 0, length: 15 },
          { type: "code", offset: 22, length: 13 },
        ],
      },
    };
    expect(mentionedHandles(ctx)).toEqual(["@dlb_design_bot"]);
  });

  test("подпись к картинке читается из caption_entities", () => {
    const ctx: any = {
      message: {
        caption: "@dlb_design_bot вот исходник",
        caption_entities: [{ type: "mention", offset: 0, length: 15 }],
      },
    };
    expect(mentionedHandles(ctx)).toEqual(["@dlb_design_bot"]);
  });

  test("текст без сущностей — пустой список, а не отсутствие разметки", () => {
    const ctx: any = { message: { text: "просто текст" } };
    expect(mentionedHandles(ctx)).toEqual([]);
  });

  test("без сообщения — undefined, чтобы включился запасной путь", () => {
    expect(mentionedHandles({} as any)).toBeUndefined();
  });
});

describe("применение", () => {
  test("обработчик передаёт разметку в анти-дуп", () => {
    expect(HANDLER_SRC).toContain(
      "shouldAllowTools(def, recent, text, bots, mentionedHandles(ctx))",
    );
  });
});
