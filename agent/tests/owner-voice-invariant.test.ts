/**
 * Аудит 2026-08-08: «действие от лица владельца требует человека» жило двумя копиями.
 *
 * `via_userbot: true` означает, что сообщение уйдёт из реального аккаунта
 * владельца (@owner_darkside), а не от бота. Поэтому такое действие обязано
 * пройти через человека при ЛЮБОЙ autonomy — включая `auto`. Условие было
 * захардкожено списком из трёх ACTION_TYPE в gateOrDispatch и, отдельной копией,
 * в self-diag; ни одна из копий ничем не связана с тем, какие инструменты поле
 * `via_userbot` реально принимают.
 *
 * Отсюда два теста: список один на всех, и он сверяется с tools-schema — то есть
 * с тем, что модели вообще предложено вызвать. Инструмент, которому завели
 * via_userbot и забыли внести в список, уходил бы от имени владельца без
 * подтверждения; теперь это падение в CI.
 */
import { describe, test, expect } from "bun:test";
import { TOOLS } from "../lib/tools-schema.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import {
  USERBOT_FORCE_APPROVAL,
  isOwnerVoice,
  type ActionType,
} from "../lib/permissions.ts";

/** Инструменты, у которых в JSON-схеме объявлено поле via_userbot. */
function toolsAcceptingUserbotFlag(): string[] {
  return TOOLS.filter((t) => {
    const props = (t.input_schema as { properties?: Record<string, unknown> })
      .properties;
    return !!props && Object.hasOwn(props, "via_userbot");
  }).map((t) => t.name);
}

describe("owner-voice: список один и сверен со схемой", () => {
  test("каждый инструмент с via_userbot требует approval", () => {
    const declared = toolsAcceptingUserbotFlag();
    // Sanity: если схема вдруг перестала объявлять флаг вообще — тест бы
    // «проходил» ни на чём.
    expect(declared.length).toBeGreaterThan(0);
    const unguarded = declared.filter(
      (name) => !USERBOT_FORCE_APPROVAL.has(name as ActionType),
    );
    expect(unguarded).toEqual([]);
  });

  test("в списке нет действий, которые флаг не принимают", () => {
    const declared = new Set(toolsAcceptingUserbotFlag());
    const phantom = [...USERBOT_FORCE_APPROVAL].filter((a) => !declared.has(a));
    expect(phantom).toEqual([]);
  });
});

/**
 * Минимальный валидный инпут на каждое owner-voice действие. Держим здесь, а не
 * в цикле по схеме: обязательные поля у них разные, и подсовывать пустой объект
 * значит проверять ветку «error», а не то, ради чего тест.
 */
const MINIMAL_INPUT: Record<string, Record<string, unknown>> = {
  SEND_MESSAGE: { text: "объявление" },
  SET_REACTION: { emoji: "👍", messageId: 7 },
  DELETE_MESSAGE: { messageId: 7 },
};

describe("флаг доезжает от модели до payload'а", () => {
  // Недостающее звено: список сверен со схемой выше, но между схемой и гейтом
  // стоит buildPayload, который собирает payload по одному полю. Поле, забытое
  // там, теряется молча — гейт видит payload БЕЗ флага и owner-voice не
  // срабатывает, а действие уходит от роль-бота. Ровно так и было с
  // SEND_MESSAGE: схема объявляла, хендлер реализовывал, сборщик выбрасывал.
  for (const action of USERBOT_FORCE_APPROVAL) {
    test(`${action}: via_userbot:true переживает buildPayload`, () => {
      const input = MINIMAL_INPUT[action];
      expect(input).toBeDefined();
      const built = buildPayload(action, { ...input, via_userbot: true }, {
        agentKey: "orchestrator",
      });
      expect(built.ok).toBe(true);
      const payload = (built as { payload: unknown }).payload;
      expect(isOwnerVoice(action, payload)).toBe(true);
    });

    test(`${action}: без флага owner-voice не появляется сам`, () => {
      const built = buildPayload(action, { ...MINIMAL_INPUT[action] }, {
        agentKey: "orchestrator",
      });
      expect(built.ok).toBe(true);
      expect(isOwnerVoice(action, (built as { payload: unknown }).payload)).toBe(
        false,
      );
    });
  }
});

describe("isOwnerVoice", () => {
  test("true только при строгом true у релевантного действия", () => {
    expect(isOwnerVoice("SEND_MESSAGE", { via_userbot: true })).toBe(true);
    expect(isOwnerVoice("SET_REACTION", { via_userbot: true })).toBe(true);
    expect(isOwnerVoice("DELETE_MESSAGE", { via_userbot: true })).toBe(true);
  });

  test("«почти истинные» значения из JSON модели не включают owner-voice", () => {
    // Важно, что это НЕ owner-voice: иначе строка "false" тоже была бы истинной.
    for (const v of ["true", 1, "1", {}, [], "yes"]) {
      expect(isOwnerVoice("SEND_MESSAGE", { via_userbot: v })).toBe(false);
    }
  });

  test("для нерелевантного действия флаг не значит ничего", () => {
    expect(isOwnerVoice("SEND_PHOTO", { via_userbot: true })).toBe(false);
    expect(isOwnerVoice("PUBLISH_TO_CHANNEL", { via_userbot: true })).toBe(false);
  });

  test("отсутствующий и мусорный payload не роняют проверку", () => {
    expect(isOwnerVoice("SEND_MESSAGE", undefined)).toBe(false);
    expect(isOwnerVoice("SEND_MESSAGE", null)).toBe(false);
    expect(isOwnerVoice("SEND_MESSAGE", {})).toBe(false);
  });
});
