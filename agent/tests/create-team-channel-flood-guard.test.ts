/**
 * Аудит 2026-08-13: CREATE_TEAM_CHANNEL — последнее живое действие юзербота без
 * flood-гварда, и при этом самое «широкое» из всех.
 *
 * Замер по коду: остальные вызовы обёрнуты (`dispatch/telegram.ts:109,160,173,
 * 203` и PUBLISH_TO_CHANNEL в `action-dispatch.ts`), а этот шёл голым. Один
 * вызов — это `1 + 2N` запросов подряд: CreateChannel, затем на каждого бота
 * getInputEntity + EditAdmin. Для канала на шестерых — тринадцать RPC в
 * аккаунт ВЛАДЕЛЬЦА, без pre-flight проверки кулдауна и без ведра.
 *
 * Две дыры складывались:
 *
 *  1. Нет гварда на входе → уже действующий FLOOD_WAIT (взведённый соседним
 *     действием) не мешал начать новую пачку из тринадцати запросов.
 *  2. Цикл приглашений ловил ЛЮБУЮ ошибку в `failed` и шёл дальше. FLOOD_WAIT
 *     на третьем боте означал ещё до 2×(N−1) запросов ВНУТРИ окна, которое
 *     сервер попросил переждать. Добавить их всё равно не выйдет — оставшиеся
 *     упрутся в тот же бан, — так что цена молотьбы чистая: приближение
 *     временной блокировки отправки на личном аккаунте.
 *
 * Почему не ретраить весь вызов: `CreateChannel` не идемпотентен. Повтор после
 * FLOOD_WAIT даёт ВТОРОЙ канал с тем же названием, а первый висит в аккаунте —
 * удалять руками. Поэтому `maxFloodRetries: 0`, а кулдаун после частичного
 * отказа взводится явно (`noteFloodWait`): гвард этого FLOOD_WAIT не видел —
 * он случился внутри цикла, который ловит ошибки сам, и на успешном возврате
 * гвард как раз СНИМАЕТ кулдаун.
 *
 * Ловушка стенда: нельзя бросать настоящую строку `FLOOD_WAIT_31` — гвард
 * распарсит её и уйдёт в реальный бэкофф на 31 секунду, тест повиснет. Здесь
 * секунды маленькие, а ретраи на пути CREATE_TEAM_CHANNEL и так выключены.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildHandle } from "../lib/userbot.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import {
  _resetFloodCooldowns,
  floodCooldownRemainingMs,
  noteFloodWait,
} from "../lib/userbot-flood.ts";
import { db } from "../lib/db.ts";

const CHAT = -998877;
const CH_ID = 4242;

// ─── Минимальный Api-неймспейс gramjs ──────────────────────────────────────
// Настоящий `telegram` тянуть незачем: коду нужны только конструкторы, а
// различать запросы удобнее по метке.
function makeApi() {
  class Req {
    _kind: string;
    args: any;
    constructor(kind: string, args: any) {
      this._kind = kind;
      this.args = args;
    }
  }
  return {
    channels: {
      CreateChannel: class extends Req {
        constructor(a: any) {
          super("CreateChannel", a);
        }
      },
      EditAdmin: class extends Req {
        constructor(a: any) {
          super("EditAdmin", a);
        }
      },
    },
    InputChannel: class {
      constructor(public a: any) {}
    },
    ChatAdminRights: class {
      constructor(public a: any) {}
    },
  };
}

/** Ошибка в форме, которую бросает gramjs: `.seconds` без строки FLOOD_WAIT_N. */
function floodErr(seconds?: number) {
  const e = new Error("FLOOD_WAIT") as Error & { seconds?: number };
  if (seconds !== undefined) e.seconds = seconds;
  return e;
}

interface StubOpts {
  /** username → ошибка, которую бросит EditAdmin для него. */
  failOn?: Record<string, Error>;
  /** CreateChannel сам бросает — до цикла приглашений. */
  createThrows?: Error;
}

function makeClient(opts: StubOpts = {}) {
  const calls: string[] = [];
  const client = {
    async connect() {},
    async disconnect() {},
    addEventHandler() {},
    async deleteMessages() {},
    async sendMessage() {
      return {};
    },
    async getInputEntity(peer: any) {
      calls.push(`getInputEntity:${String(peer)}`);
      return { _: "user", peer };
    },
    async invoke(req: any) {
      calls.push(`invoke:${req._kind}`);
      if (req._kind === "CreateChannel") {
        if (opts.createThrows) throw opts.createThrows;
        return {
          chats: [{ id: CH_ID, accessHash: 777, title: req.args.title }],
        };
      }
      if (req._kind === "EditAdmin") {
        // userId сюда приезжает результатом getInputEntity — вытаскиваем из
        // него username, чтобы решить, падать ли на этом боте.
        const u = String(req.args.userId?.peer ?? "");
        const err = opts.failOn?.[u];
        if (err) throw err;
        return {};
      }
      return {};
    },
  };
  return { client: client as any, calls };
}

function handle(opts: StubOpts = {}) {
  const { client, calls } = makeClient(opts);
  return { h: buildHandle(client, makeApi()), calls };
}

const BOTS = ["a_bot", "b_bot", "c_bot", "d_bot"];

beforeEach(() => {
  _resetFloodCooldowns();
});

afterEach(() => {
  _resetFloodCooldowns();
  db.prepare(`DELETE FROM team_channels WHERE created_by_chat = ?`).run(CHAT);
});

describe("createTeamChannel: цикл приглашений останавливается на FLOOD_WAIT", () => {
  test("после отказа сервера оставшиеся боты не порождают запросов", async () => {
    const { h, calls } = handle({ failOn: { b_bot: floodErr(30) } });
    const res = await h.createTeamChannel("Канал", "", BOTS);

    expect(res.floodWaitSeconds).toBe(30);
    expect(res.added).toEqual(["a_bot"]);
    // Оставшиеся честно помечены неудачей — молча они не исчезают.
    expect(res.failed).toEqual(["b_bot", "c_bot", "d_bot"]);

    // Главное: c_bot и d_bot не стоили ни одного RPC.
    expect(calls.filter((c) => c.startsWith("getInputEntity"))).toEqual([
      "getInputEntity:a_bot",
      "getInputEntity:b_bot",
    ]);
    expect(calls.filter((c) => c === "invoke:EditAdmin")).toHaveLength(2);
    // 1 CreateChannel + 2 EditAdmin вместо 1 + 4.
    expect(calls.filter((c) => c.startsWith("invoke:"))).toHaveLength(3);
  });

  test("FLOOD_WAIT без .seconds всё равно возвращает секунды — кулдаун взводить нечем иначе", async () => {
    const e = new Error("FLOOD_WAIT_ (без числа)");
    const { h } = handle({ failOn: { a_bot: e } });
    const res = await h.createTeamChannel("Канал", "", BOTS);
    expect(res.floodWaitSeconds).toBeGreaterThan(0);
    expect(res.added).toEqual([]);
  });

  test("обычная ошибка на одном боте не останавливает остальных", async () => {
    // Регресс-якорь: раньше цикл шёл дальше ПО ЛЮБОЙ ошибке, и это было верно
    // для всего, кроме FLOOD_WAIT. Сузить остановку до флуда — часть фикса.
    const { h, calls } = handle({
      failOn: { b_bot: new Error("USER_NOT_MUTUAL_CONTACT") },
    });
    const res = await h.createTeamChannel("Канал", "", BOTS);

    expect(res.floodWaitSeconds).toBeUndefined();
    expect(res.added).toEqual(["a_bot", "c_bot", "d_bot"]);
    expect(res.failed).toEqual(["b_bot"]);
    expect(calls.filter((c) => c === "invoke:EditAdmin")).toHaveLength(4);
  });

  test("без ошибок — все боты админы, флага нет", async () => {
    const { h } = handle();
    const res = await h.createTeamChannel("Канал", "о", BOTS);
    expect(res.added).toEqual(BOTS);
    expect(res.failed).toEqual([]);
    expect(res.floodWaitSeconds).toBeUndefined();
    expect(res.channelId).toBe(Number(`-100${CH_ID}`));
  });
});

// ─── Уровень действия ──────────────────────────────────────────────────────

function ctxFor(h: any) {
  return {
    agentKey: "orchestrator",
    chatId: CHAT,
    userbot: h,
    resolveAgent: (role: string) => ({ username: `@${role}_bot` }),
  } as any;
}

const PAYLOAD = { title: "Канал", about: "", roles: ["smm"] } as any;

describe("CREATE_TEAM_CHANNEL: гвард на входе", () => {
  test("действующий кулдаун не пускает вызов — ни одного RPC в аккаунт", async () => {
    // Ровно та дыра, ради которой гвард и ставится: FLOOD_WAIT взведён соседним
    // действием, а создание канала уходило в аккаунт владельца пачкой из 1+2N.
    noteFloodWait("orchestrator", 45);
    let called = 0;
    const h = {
      isNoop: false,
      createTeamChannel: async () => {
        called++;
        return { channelId: -1001, title: "x", added: [], failed: [] };
      },
    };

    const r = await dispatchAction("CREATE_TEAM_CHANNEL" as any, PAYLOAD, ctxFor(h));
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
    expect(String((r as any).error)).toMatch(/FLOOD_WAIT|rate limit/i);
  });

  test("FLOOD_WAIT из самого CreateChannel не ретраится — второй канал не создаётся", async () => {
    let called = 0;
    const h = {
      isNoop: false,
      createTeamChannel: async () => {
        called++;
        throw floodErr(5);
      },
    };

    const r = await dispatchAction("CREATE_TEAM_CHANNEL" as any, PAYLOAD, ctxFor(h));
    expect(r.ok).toBe(false);
    // maxFloodRetries: 0. С дефолтными тремя здесь было бы четыре канала —
    // точнее, четыре попытки, каждая из которых могла создать канал.
    expect(called).toBe(1);
    // Кулдаун при этом взведён самим гвардом.
    expect(floodCooldownRemainingMs("orchestrator")).toBeGreaterThan(0);
  });
});

describe("CREATE_TEAM_CHANNEL: частичный FLOOD_WAIT взводит кулдаун", () => {
  test("канал создан, но следующее действие юзербота молчит", async () => {
    const h = {
      isNoop: false,
      createTeamChannel: async () => ({
        channelId: -1004242,
        title: "Канал",
        added: ["a_bot"],
        failed: ["b_bot"],
        floodWaitSeconds: 20,
      }),
    };

    const r = await dispatchAction("CREATE_TEAM_CHANNEL" as any, PAYLOAD, ctxFor(h));
    // Канал реально создан — отказом это не становится, иначе модель попробует
    // ещё раз и заведёт второй.
    expect(r.ok).toBe(true);
    expect((r as any).result.floodWaitSeconds).toBe(20);

    // И вот главное: успешный возврат гвард трактует как «сервер принял» и
    // СНИМАЕТ кулдаун. Взводим его после — иначе следующее действие ударит в
    // тот же бан через секунду.
    const left = floodCooldownRemainingMs("orchestrator");
    expect(left).toBeGreaterThan(15_000);
    expect(left).toBeLessThanOrEqual(20_000);
  });

  test("без FLOOD_WAIT кулдаун не взводится", async () => {
    const h = {
      isNoop: false,
      createTeamChannel: async () => ({
        channelId: -1004243,
        title: "Канал",
        added: ["a_bot", "b_bot"],
        failed: [],
      }),
    };

    const r = await dispatchAction("CREATE_TEAM_CHANNEL" as any, PAYLOAD, ctxFor(h));
    expect(r.ok).toBe(true);
    expect(floodCooldownRemainingMs("orchestrator")).toBe(0);
  });
});
