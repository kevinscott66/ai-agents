/**
 * Аудит 2026-08-13, путь исполнения одобренного + HTTP-поверхность Mini App.
 *
 * Общее у всех четырёх дефектов — они выглядят как нормальная работа. Заявка
 * «одобрена», страница журнала «загрузилась», SSE «подключён». Ни один не виден
 * ни в статусе ответа, ни в строке аудита.
 *
 * 1. Набор резолверов для исполнения собирался ДВАЖДЫ — `orchestrator-team.ts`
 *    для `/approve` в чате и `orchestrator/services.ts` для Mini App, — и
 *    разъехался: в веб-версии не было `handoffDeps`. Правка 2026-08-12 добавила
 *    туда `resolveAgent` и тем самым сдвинула отказ на семь строк ниже
 *    (`action-dispatch.ts:804` → `:811`), а не убрала его.
 *
 * 2. Бакет «этот бот в этом чате» тратил не тот бот: с Telegram-пути приходил
 *    id ОРКЕСТРАТОРА (он регистрирует `/approve`), с Mini App — `undefined`, а
 *    на `undefined` `checkPerBotPerChatRateLimit` молча отвечает «ок»
 *    (`rate-limits.ts:312`).
 *
 * 3. `Bun.serve` без `idleTimeout`: дефолт 10 секунд при keepalive SSE в 25.
 *
 * 4. Курсор `before_id` искали только в `agent_actions`. Строка, уехавшая в
 *    архив (`db-maint.ts:243` переносит и УДАЛЯЕТ), давала «не нашли» → условие
 *    не добавлялось вовсе → сервер отдавал самую свежую страницу заново.
 */
import {
  describe,
  test,
  expect,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { db } from "../lib/db.ts";
import {
  createApproval,
  decideApproval,
  getApproval,
  markApprovalFailed,
} from "../lib/approvals.ts";
import {
  executeApproved,
  buildApprovalExecDeps,
  type ApprovalExecDeps,
} from "../lib/commands.ts";
import {
  startMiniappServer,
  MINIAPP_IDLE_TIMEOUT_S,
  SSE_KEEPALIVE_MS,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";
import {
  _resetRateLimits,
  checkPerBotPerChatRateLimit,
} from "../lib/rate-limits.ts";
import type { RunningBot } from "../lib/types.ts";

const CHAT_ID = -100_813_001;

/** Заявку подаёт backend — значит и вызов делает бот backend'а. */
const REQUESTER = "backend";
const REQUESTER_BOT_ID = 777_001;
/** Оркестратор тут ни при чём: он лишь владелец команды `/approve`. */
const ORCHESTRATOR_BOT_ID = 777_002;
const TARGET_ROLE = "qa";

const fakeBot = (key: string, id: number) =>
  ({
    def: { key },
    username: `delabs_${key}_bot`,
    id,
    bot: { telegram: { sendMessage: async () => ({ message_id: 1 }) } },
  }) as unknown as RunningBot;

const BOTS = [
  fakeBot(REQUESTER, REQUESTER_BOT_ID),
  fakeBot("orchestrator", ORCHESTRATOR_BOT_ID),
  fakeBot(TARGET_ROLE, 777_003),
];

const execDeps = (): ApprovalExecDeps => ({
  ...buildApprovalExecDeps({ bots: BOTS, handoffDeps: {} as never }),
  respondAsImpl: async () => "делегат ответил",
});

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT_ID);
  _resetRateLimits();
});

/** Выдать право с requires_approval и вернуть точный откат. */
function grant(actionType: string): () => void {
  const prev = db
    .prepare(
      `SELECT allowed, requires_approval FROM permissions
       WHERE agent_key = ? AND action_type = ?`,
    )
    .get(REQUESTER, actionType) as
    | { allowed: number; requires_approval: number }
    | undefined;
  db.prepare(
    `INSERT INTO permissions (agent_key, action_type, allowed, requires_approval)
     VALUES (?, ?, 1, 1)
     ON CONFLICT(agent_key, action_type) DO UPDATE
       SET allowed = 1, requires_approval = 1`,
  ).run(REQUESTER, actionType);
  return () => {
    if (prev) {
      db.prepare(
        `UPDATE permissions SET allowed = ?, requires_approval = ?
         WHERE agent_key = ? AND action_type = ?`,
      ).run(prev.allowed, prev.requires_approval, REQUESTER, actionType);
    } else {
      db.prepare(
        `DELETE FROM permissions WHERE agent_key = ? AND action_type = ?`,
      ).run(REQUESTER, actionType);
    }
  };
}

function approvedRow(actionType: string, payload: unknown) {
  const a = createApproval({
    actionId: `act-tr-${crypto.randomUUID()}`,
    chatId: CHAT_ID,
    requestedBy: REQUESTER,
    actionType,
    payload,
  });
  return decideApproval(a.id, "approved", "owner");
}

const DELEGATE_PAYLOAD = { role: TARGET_ROLE, task: "почини сборку" };

describe("исполнение одобренного: набор резолверов не разъезжается", () => {
  test("конструктор отдаёт handoffDeps — ровно то поле, которого не было в вебе", () => {
    const deps = buildApprovalExecDeps({ bots: BOTS, handoffDeps: {} as never });
    expect(deps.handoffDeps).toBeDefined();
    expect(deps.resolveAgent).toBeInstanceOf(Function);
    expect(deps.resolveTg).toBeInstanceOf(Function);
    expect(deps.resolveAgent!(REQUESTER)?.id).toBe(REQUESTER_BOT_ID);
    // botId в набор намеренно не входит: бота выбирает executeApproved по
    // агенту-заявителю. Это поле и было той ручкой, которой на Telegram-пути
    // подставляли оркестратора.
    expect(deps.botId).toBeUndefined();
  });

  test("DELEGATE_TO_ROLE исполняется тем набором, что отдаёт конструктор", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    try {
      const res = await executeApproved(
        approvedRow("DELEGATE_TO_ROLE", DELEGATE_PAYLOAD),
        execDeps(),
      );
      expect(JSON.stringify(res)).toContain("делегат ответил");
    } finally {
      undo();
    }
  });

  test("без handoffDeps заявка сгорает НЕОБРАТИМО — вот цена расхождения", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    try {
      const row = approvedRow("DELEGATE_TO_ROLE", DELEGATE_PAYLOAD);
      // Ровно тот набор, что Mini App собирал руками: с resolveAgent (правка
      // 2026-08-12), но без handoffDeps.
      const webDepsBefore: ApprovalExecDeps = {
        resolveTg: (k: string) => BOTS.find((b) => b.def.key === k)?.bot.telegram,
        resolveAgent: (k: string) => BOTS.find((b) => b.def.key === k),
        respondAsImpl: async () => "делегат ответил",
      };
      await expect(executeApproved(row, webDepsBefore)).rejects.toThrow(
        /handoffDeps/,
      );

      // Дальше — почему это дороже обычного отказа. Решение коммитится ДО
      // исполнения (и правильно: иначе краш между отправкой и записью дал бы
      // повтор), а провал ручка помечает failed.
      expect(
        markApprovalFailed(row.id, "no handoffDeps in dispatch ctx"),
      ).not.toBeNull();
      expect(getApproval(row.id)?.status).toBe("failed");
      // Из pending строка не вернётся ни в веб (`WHERE status = 'pending'`), ни
      // в `/approve`. Одно нажатие уничтожало заявку, не выполнив действия.
      expect(() => decideApproval(row.id, "approved", "owner")).toThrow(
        /already failed/,
      );
    } finally {
      undo();
    }
  });
});

describe("одобренное действие тратит бакет своего бота", () => {
  test("списывается бот агента-заявителя, а не оркестратора и не пустота", async () => {
    const undo = grant("DELEGATE_TO_ROLE");
    const prevMax = process.env.RATE_LIMIT_PER_CHAT_PER_MIN;
    process.env.RATE_LIMIT_PER_CHAT_PER_MIN = "1";
    try {
      await executeApproved(
        approvedRow("DELEGATE_TO_ROLE", DELEGATE_PAYLOAD),
        execDeps(),
      );
      // При max=1 единственный способ увидеть трату — исчерпание бакета. Ключ
      // содержит id бота, поэтому промах по боту виден здесь прямо.
      expect(
        checkPerBotPerChatRateLimit(
          REQUESTER_BOT_ID,
          CHAT_ID,
          "DELEGATE_TO_ROLE",
        ).ok,
      ).toBe(false);
      // Бакет оркестратора, которым его ошибочно считали с Telegram-пути,
      // остался нетронутым.
      expect(
        checkPerBotPerChatRateLimit(
          ORCHESTRATOR_BOT_ID,
          CHAT_ID,
          "DELEGATE_TO_ROLE",
        ).ok,
      ).toBe(true);
    } finally {
      if (prevMax === undefined) delete process.env.RATE_LIMIT_PER_CHAT_PER_MIN;
      else process.env.RATE_LIMIT_PER_CHAT_PER_MIN = prevMax;
      undo();
    }
  });
});

describe("транспорт Mini App: сокет живёт дольше, чем молчит SSE", () => {
  test("тайм-аут простоя заведомо больше периода keepalive", () => {
    // Инвариант, а не число: сломается ровно тогда, когда эти две настройки
    // снова разведут. До правки было 10 с (дефолт Bun) против 25 с keepalive,
    // то есть SSE рвался на каждой десятой секунде, всегда.
    expect(MINIAPP_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(SSE_KEEPALIVE_MS * 2);
    // 255 — потолок, который принимает Bun; больше он отвергает.
    expect(MINIAPP_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });
});

describe("/api/actions: курсор, уехавший в архив", () => {
  const BOT_TOKEN = "test_bot_token_for_cursor_archive";
  const ADMIN_ID = 900_813;
  const AGENT_KEY = "cursor_archive_probe";
  // Свой chat_id: общий afterEach выше чистит agent_actions по CHAT_ID, а эти
  // строки живут от beforeAll до afterAll.
  const CHAT = -100_813_002;
  const T0 = 1_770_000_100_000;
  let server: MiniappServerHandle;
  let base: string;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: {
        "X-Telegram-Init-Data": buildInitData(BOT_TOKEN, {
          auth_date: String(Math.floor(Date.now() / 1000)),
          query_id: `q-${ADMIN_ID}`,
          user: JSON.stringify({ id: ADMIN_ID, first_name: "U" }),
        }),
      },
    });

  const ARCHIVE_COLS =
    `(id, agent_key, task_id, chat_id, action_type, payload, status, result, error, created_at, archived_at)`;

  beforeAll(() => {
    server = startMiniappServer({
      port: 0,
      allowedUserIds: [ADMIN_ID],
      adminUserIds: [ADMIN_ID],
      botToken: BOT_TOKEN,
    });
    base = `http://127.0.0.1:${server.port}`;

    const insLive = db.prepare(
      `INSERT INTO agent_actions
         (id, agent_key, task_id, chat_id, action_type, payload, status, result, error, created_at)
       VALUES (?, ?, NULL, ?, 'SEND_MESSAGE', '{}', 'ok', NULL, NULL, ?)`,
    );
    for (let i = 0; i < 3; i++) {
      insLive.run(`ca_live_${i}`, AGENT_KEY, CHAT, T0 + i);
    }
    // Строки, которые archiveOldRows перенёс и удалил из источника: одна новее
    // всех живых, одна между ними.
    const insArch = db.prepare(
      `INSERT INTO agent_actions_archive ${ARCHIVE_COLS}
       VALUES (?, ?, NULL, ?, 'SEND_MESSAGE', '{}', 'ok', NULL, NULL, ?, ?)`,
    );
    insArch.run(`ca_gone_top`, AGENT_KEY, CHAT, T0 + 9, T0 + 100);
    insArch.run(`ca_gone_mid`, AGENT_KEY, CHAT, T0 + 1, T0 + 100);
  });

  afterAll(() => {
    server.stop();
    _resetRateLimiter();
    db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(AGENT_KEY);
    db.prepare(`DELETE FROM agent_actions_archive WHERE agent_key = ?`).run(
      AGENT_KEY,
    );
  });

  test("курсор из архива фильтрует, а не отваливается молча", async () => {
    // ca_gone_mid = T0+1: строго старше него — только ca_live_0. Молчаливый
    // отброс фильтра вернул бы все три, и клиент дописал бы их к показанным.
    const r = await get(
      `/api/actions?agent=${AGENT_KEY}&limit=10&before_id=ca_gone_mid`,
    );
    expect(r.status).toBe(200);
    expect((await r.json()).actions.map((a: any) => a.id)).toEqual([
      "ca_live_0",
    ]);
  });

  test("курсор новее всех живых отдаёт их все — и ровно по разу", async () => {
    const r = await get(
      `/api/actions?agent=${AGENT_KEY}&limit=10&before_id=ca_gone_top`,
    );
    expect((await r.json()).actions.map((a: any) => a.id)).toEqual([
      "ca_live_2",
      "ca_live_1",
      "ca_live_0",
    ]);
  });

  test("неизвестный before_id — это 400, а не первая страница заново", async () => {
    const r = await get(
      `/api/actions?agent=${AGENT_KEY}&limit=10&before_id=ca_no_such_row`,
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("before_id");
  });
});
