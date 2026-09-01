/**
 * Аудит 2026-08-11: неудача Bot API превращала обычное удаление в удаление от
 * лица владельца — любой роли и без апрува.
 *
 * У DELETE_MESSAGE две ветки. Явная (`via_userbot: true`) обвешана обеими
 * защитами: `isOwnerVoice` → `payloadForcesApproval` требует человека при любой
 * autonomy, а хендлер отказывает всем, кроме orchestrator. И неявная: обычное
 * `tgDeleteMessage` упало → catch → тот же `ub.deleteMessage`. В ней не было ни
 * одной из двух проверок.
 *
 * Это не редкий путь, а обычный: Bot API не даёт боту удалять чужие сообщения
 * старше 48 часов, а без прав администратора — вообще никакие. То есть падение
 * здесь — норма, и норма молча повышала привилегию.
 *
 * Соседний SET_REACTION ровно этот фолбэк уже сузил до orchestrator, и
 * комментарий там гласит «no silent owner-account escalation for other
 * callers». У удаления — того же вида и необратимого — проверки не было.
 *
 * Гейт при этом видел действие БЕЗ `via_userbot`, то есть решал про удаление
 * ботом. Исполнялось другое.
 *
 * Инвариант: неявный фолбэк не может быть привилегированнее того, что одобрил
 * гейт. Владелец-аккаунт — только через явный via_userbot, то есть через апрув.
 */
import { describe, test, expect } from "bun:test";
import { handleDeleteMessage } from "../lib/dispatch/telegram.ts";

const CHAT = -100777000111;

function fakeUb() {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    ub: {
      isNoop: false,
      async deleteMessage(c: number, m: number) {
        calls.push([c, m]);
      },
    } as never,
  };
}

/** Bot API, который всегда падает — как он и падает на чужих сообщениях. */
const failingTelegram = {
  deleteMessage: async () => {
    throw new Error("400: Bad Request: message can't be deleted");
  },
} as never;

describe("фолбэк удаления не повышает привилегию", () => {
  test("роль-бот: аккаунт владельца не трогаем", async () => {
    const { ub, calls } = fakeUb();
    const res = await handleDeleteMessage(
      { messageId: 42 } as never,
      { agentKey: "smm", chatId: CHAT, telegram: failingTelegram, userbot: ub },
    ).catch((e) => ({ ok: false as const, error: String(e) }));
    expect(calls).toHaveLength(0);
    expect(res.ok).toBe(false);
  });

  test("даже orchestrator — только через явный via_userbot", async () => {
    // Явная ветка требует апрува (isOwnerVoice). Неявная его обходила, поэтому
    // «оркестратору можно» здесь означало бы «оркестратору можно без спроса».
    const { ub, calls } = fakeUb();
    const res = await handleDeleteMessage(
      { messageId: 42 } as never,
      { agentKey: "orchestrator", chatId: CHAT, telegram: failingTelegram, userbot: ub },
    ).catch((e) => ({ ok: false as const, error: String(e) }));
    expect(calls).toHaveLength(0);
    expect(res.ok).toBe(false);
  });

  test("в отказе сказано, как сделать это легально", async () => {
    const { ub } = fakeUb();
    const res = await handleDeleteMessage(
      { messageId: 42 } as never,
      { agentKey: "orchestrator", chatId: CHAT, telegram: failingTelegram, userbot: ub },
    ).catch((e) => ({ ok: false as const, error: String(e) }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("via_userbot");
  });

  test("явная ветка via_userbot по-прежнему работает у orchestrator", async () => {
    const { ub, calls } = fakeUb();
    const res = await handleDeleteMessage(
      { messageId: 42, via_userbot: true } as never,
      { agentKey: "orchestrator", chatId: CHAT, telegram: failingTelegram, userbot: ub },
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual([[CHAT, 42]]);
  });

  test("явная ветка via_userbot закрыта для остальных ролей", async () => {
    const { ub, calls } = fakeUb();
    const res = await handleDeleteMessage(
      { messageId: 42, via_userbot: true } as never,
      { agentKey: "smm", chatId: CHAT, telegram: failingTelegram, userbot: ub },
    );
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("успешное удаление ботом не изменилось", async () => {
    const { ub, calls } = fakeUb();
    const ok = { deleteMessage: async () => true } as never;
    const res = await handleDeleteMessage(
      { messageId: 42 } as never,
      { agentKey: "smm", chatId: CHAT, telegram: ok, userbot: ub },
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
