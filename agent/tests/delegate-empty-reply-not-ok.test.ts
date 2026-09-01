/**
 * Аудит 2026-08-13: провал делегата приезжал к модели как успех.
 *
 * Два звена одной цепи.
 *
 * 1. `respondAs` заканчивался `catch (e) { log.error(...); return null; }` —
 *    глушителем на ВСЁ, что случилось внутри делегата. Исчерпанный дневной
 *    бюджет (`BudgetExceededError`), 500 от Anthropic, бан бота в чате
 *    превращались в тот же `null`, что и «делегат честно промолчал».
 *
 * 2. `DELEGATE_TO_ROLE` на `null` закрывал строку доски как `failed`, а модели
 *    в тот же миг отдавал `{ok:true, delegated:true, reply:null}`.
 *
 * То есть БД и модель расходились в показаниях, и расходились ровно в ту
 * сторону, где оркестратор рапортует владельцу «сделано», а в чат не пришло
 * ничего. С бюджетом дороже всего: у кого он кончился, тот не сработает и в
 * следующий раз, — а вызывающий об этом не узнаёт и платит за новый круг
 * своими токенами.
 *
 * Чинилось это не пробросом наружу, а типом результата: `respondAs` вернулся к
 * явному `HandoffOutcome` — `answered` / `acted` / `failed` / `skipped`. Так
 * «делегат ответил», «делегат закончил ход инструментом», «делегат сломался» и
 * «делегата не звали» перестали быть одним и тем же `null`, и при этом каскад
 * по @-упоминанию (`void respondAs(...)`) не превратился в источник
 * unhandled rejection, а `SPLIT_TASK` не рвётся на первом же сломавшемся
 * делегате. Тесты ниже держат именно этот контракт — по одному на каждый из
 * четырёх исходов и на оба звена цепи.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import type { DispatchCtx } from "../lib/action-dispatch.ts";
import { respondAs } from "../lib/handoff.ts";
import type { RespondAsOpts, HandoffDeps, HandoffOutcome } from "../lib/handoff.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";
import { db } from "../lib/db.ts";
import { listTasksByChat } from "../lib/tasks.ts";
import type { RunningBot } from "../lib/types.ts";

const CHAT = -100_813_500;

const fakeBot = (key: string) =>
  ({
    def: { key },
    username: `delabs_${key}_bot`,
    id: 555_000,
    bot: {
      telegram: {
        // Настоящий respondAs первым делом шлёт «печатает…»; без заглушки
        // тест поймал бы TypeError вместо той ошибки, которую проверяет.
        sendChatAction: async () => true,
        sendMessage: async () => ({ message_id: 1 }),
      },
    },
  }) as unknown as RunningBot;

type Impl = (o: RespondAsOpts, d: HandoffDeps) => Promise<unknown>;

function ctx(impl: Impl): DispatchCtx {
  return {
    agentKey: "orchestrator",
    chatId: CHAT,
    resolveAgent: (k: string) => fakeBot(k),
    handoffDeps: {} as HandoffDeps,
    respondAsImpl: impl as never,
  } as DispatchCtx;
}

const delegate = (impl: Impl) =>
  dispatchAction(
    "DELEGATE_TO_ROLE",
    { role: "backend", task: "почини сборку" },
    ctx(impl),
  );

afterEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
});

describe("делегат не отработал → модель узнаёт об этом", () => {
  test("failed — это ok:false, а не ok:true с reply:null", async () => {
    const res = await delegate(async () => ({
      status: "failed" as const,
      reason: "connect ECONNREFUSED",
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Признак, по которому tool-loop ставит `is_error`, ровно один:
      // `ok === false` (agent/lib/tool-loop.ts). Именно на нём модель решает,
      // рапортовать ли владельцу «готово».
      expect(String(res.error)).toContain("delegate_failed");
      expect(String(res.error)).toContain("ECONNREFUSED");
    }
  });

  test("skipped (роль остановлена) — тоже не успех", async () => {
    // Отдельный исход: делегата не звали вовсе. Слить его с `failed` можно, а
    // с `answered` — нельзя, иначе пауза на роли читается как выполненная работа.
    const res = await delegate(async () => ({
      status: "skipped" as const,
      reason: "роль backend остановлена (paused)",
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.error)).toContain("delegate_skipped");
  });

  test("пустой результат легаси-вызова тоже провал, а не тихое «ок»", async () => {
    // `null` — форма, в которой респонс приезжал ДО правки. Нормализация
    // (`normalizeHandoffOutcome`) обязана считать её провалом: иначе старый
    // путь вернул бы ровно тот дефект, ради которого всё и затевалось.
    const res = await delegate(async () => null);
    expect(res.ok).toBe(false);
  });

  test("доска и модель говорят одно и то же", async () => {
    const res = await delegate(async () => ({
      status: "failed" as const,
      reason: "connect ECONNREFUSED",
    }));
    const rows = listTasksByChat(CHAT);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("failed");
    // Раньше здесь было `failed` на доске против `ok:true` у модели.
    expect(res.ok).toBe(false);
  });

  test("непустой ответ по-прежнему успех и доезжает до модели целиком", async () => {
    const res = await delegate(async () => ({
      status: "answered" as const,
      reply: "сборка починена",
    }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { reply: string }).reply).toBe("сборка починена");
    }
    expect(listTasksByChat(CHAT)[0].status).toBe("done");
  });

  test("ход, закрытый инструментом, — успех без текста, а не провал", async () => {
    // Граница ровно здесь. У ролей из MAKER_ROLES конец хода инструментом —
    // штатный: картинка уже в чате, текста нет. Считать это провалом значило бы
    // ронять нормальную работу; выдавать пустоту за ответ — заставлять модель
    // пересказывать то, чего она не читала. Отсюда третий исход и пометка.
    const res = await delegate(async () => ({ status: "acted" as const }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { reply: unknown; note?: string };
      expect(r.reply).toBeNull();
      expect(String(r.note)).toContain("действием");
    }
    expect(listTasksByChat(CHAT)[0].status).toBe("done");
  });
});

describe("ошибка внутри делегата доезжает текстом, а не глотается", () => {
  test("неожиданный throw закрывает строку доски, а не оставляет её висеть", async () => {
    // Штатные провалы приезжают исходом `failed`; сюда попадает только то, что
    // сломалось мимо контракта. Наружу диспатч всё равно отдаёт `ok:false` с
    // текстом — исключение из dispatchAction наружу не выходит, и это важно:
    // `SPLIT_TASK` гоняет DELEGATE_TO_ROLE в цикле, и один сломавшийся делегат
    // не должен обрывать остальные строки разбиения. Но строку доски закрыть
    // всё равно обязаны — иначе таск висит в `in_progress` до gc_stale.
    const res = await delegate(async () => {
      throw new Error("downstream boom");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.error)).toContain("downstream boom");
    const rows = listTasksByChat(CHAT);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(String(rows[0].error)).toContain("downstream boom");
  });
});

/**
 * Выше диспатч звали со стабом вместо respondAs — то есть проверяли второе
 * звено. Здесь работает НАСТОЯЩИЙ respondAs, и падает то, что падает в проде:
 * вызов модели.
 */
describe("настоящий respondAs больше не превращает ошибку в null", () => {
  const brokenDeps = (err: () => never) =>
    ({
      anthropic: {
        messages: {
          create: async () => err(),
        },
      },
      model: "t",
      historyLimit: 5,
      bots: [],
    }) as never as HandoffDeps;

  const netDown = () =>
    brokenDeps(() => {
      throw new Error("сеть в тесте недоступна");
    });

  const opts = (extra: Partial<RespondAsOpts> = {}): RespondAsOpts =>
    ({
      target: fakeBot("backend"),
      chatId: String(CHAT),
      triggerText: "почини сборку",
      triggerAgentKey: "orchestrator",
      depth: 1,
      visited: new Set(["orchestrator", "backend"]),
      ...extra,
    }) as RespondAsOpts;

  test("сбой вызова модели → failed с причиной, а не null", async () => {
    const out = (await respondAs(opts(), netDown())) as HandoffOutcome;
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.reason).toMatch(/сеть в тесте недоступна/);
    }
  });

  test("исчерпанный дневной бюджет — не «пусто», а причина с числами", async () => {
    // Дороже всех прочих: у кого бюджет кончился, тот не сработает и в
    // следующий раз. Пока причина не доезжает до вызывающего, он продолжает
    // раздавать этому агенту работу — каждый круг за СВОИ токены.
    const out = (await respondAs(
      opts(),
      brokenDeps(() => {
        throw new BudgetExceededError("backend", 900_000, 800_000);
      }),
    )) as HandoffOutcome;
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.reason).toMatch(/budget|бюджет|900000|800000/i);
    }
  });

  test("осознанный пропуск — skipped, а не failed и не исключение", async () => {
    // Граница правки: наружу отдаётся именно ОШИБКА, а не любой отказ работать.
    // Исчерпанный budget хода — решение самого respondAs не звать делегата
    // (второй такой же путь — остановленная цель, `agentStopReason`). Это
    // штатный «нечего делать» и он обязан остаться отличимым: иначе каскад по
    // @-упоминанию начнёт рапортовать провал о своём же ограничителе.
    const out = (await respondAs(
      opts({ budget: { n: 5, max: 5 } } as Partial<RespondAsOpts>),
      netDown(),
    )) as HandoffOutcome;
    expect(out.status).toBe("skipped");
  });

  test("через диспатч это ok:false с настоящей причиной, а не «нет ответа»", async () => {
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "почини сборку" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k: string) => fakeBot(k),
        handoffDeps: netDown(),
        delegationChain: ["orchestrator"],
      } as DispatchCtx,
    );
    expect(res.ok).toBe(false);
    // Ключевое: причина, а не общая формулировка про пустой ответ. По ней
    // владелец в логе действий отличит «сеть легла» от «роль промолчала».
    if (!res.ok) expect(String(res.error)).toMatch(/сеть в тесте недоступна/);
    expect(listTasksByChat(CHAT)[0].status).toBe("failed");
  });
});
