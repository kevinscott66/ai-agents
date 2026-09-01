/**
 * Аудит 2026-08-20: ответ делегата резался на 4000 символов МОЛЧА.
 *
 * `DELEGATE_TO_ROLE` отдаёт оркестратору текст ответа роли, чтобы тот передал
 * результат следующему шагу пайплайна. Резалось это `replyText.slice(0, 4000)`
 * без единого признака обрезки — и в tool_result, и в строке доски. Оркестратор
 * получал текст, оборванный на полуслове, и пересказывал его человеку как
 * полный ответ роли; а конец текста роли — это обычно вывод, а не вступление.
 *
 * В самом репозитории конвенция обратная: QUERY_DB и MAC_RUN_CLAUDE отдают
 * `truncated` в теле результата, GET_METRICS дописывает «…(truncated)»,
 * PUBLISH_TO_CHANNEL прямо запрещает выдавать сокращённый пост за полный.
 *
 * Инварианты: (1) короткий ответ не трогаем вовсе; (2) длинный помечен и в
 * тексте, и полем; (3) сказано, сколько символов было на самом деле.
 */
import { describe, test, expect } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";

const CHAT = -1_000_820;
const LIMIT = 4000;

const fakeBot = (k: string): RunningBot => ({
  def: { key: k as never, name: k, envToken: "", system: "" } as never,
  bot: { telegram: {} } as never,
  username: `${k}_bot`,
  id: 100,
});
const fakeDeps = (): HandoffDeps => ({
  anthropic: {} as never,
  model: "t",
  historyLimit: 10,
  bots: [],
});

/** Прогнать делегирование, где роль вернула ровно `reply`. */
async function delegate(reply: string) {
  const res = await dispatchAction(
    "DELEGATE_TO_ROLE",
    { role: "design", task: "макет" },
    {
      agentKey: "orchestrator",
      chatId: CHAT,
      resolveAgent: (k) => fakeBot(k),
      handoffDeps: fakeDeps(),
      respondAsImpl: (async (_o: RespondAsOpts) => ({
        status: "answered",
        reply,
      })) as never,
      requestId: "req-trunc",
    },
  );
  expect(res.ok).toBe(true);
  return (res as { result: Record<string, unknown> }).result;
}

describe("DELEGATE_TO_ROLE: обрезка ответа роли называет себя", () => {
  test("короткий ответ доезжает байт в байт и без лишних полей", async () => {
    const short = "готово, макет в чате";
    const r = await delegate(short);
    expect(r.reply).toBe(short);
    expect(r.truncated).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  test("ровно на границе — ещё не обрезка", async () => {
    const exact = "я".repeat(LIMIT);
    const r = await delegate(exact);
    expect(r.reply).toBe(exact);
    expect(r.truncated).toBeUndefined();
  });

  test("длинный ответ помечен и в тексте, и полем", async () => {
    const long = "х".repeat(LIMIT + 500);
    const r = await delegate(long);
    expect(typeof r.reply).toBe("string");
    expect(r.reply as string).toStartWith("х".repeat(100));
    expect(r.reply as string).toEndWith("…(truncated)");
    expect(r.truncated).toBe(true);
    expect(r.reply_full_len).toBe(LIMIT + 500);
  });

  test("в note сказано, что обрезанный — не весь ответ", async () => {
    const r = await delegate("х".repeat(LIMIT + 1));
    const note = String(r.note);
    expect(note).toContain("не целиком");
    expect(note).toContain(String(LIMIT + 1));
    expect(note).toContain("не выдавай обрезанный за весь ответ");
  });

  test("ход без текста по-прежнему объясняется своим note", async () => {
    // Ветка `acted`: пометка про обрезку не должна её затирать.
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: (async () => ({ status: "acted" })) as never,
        requestId: "req-acted",
      },
    );
    const r = (res as { result: Record<string, unknown> }).result;
    expect(r.reply).toBeNull();
    expect(r.truncated).toBeUndefined();
    expect(String(r.note)).toContain("текстового ответа нет");
  });
});
