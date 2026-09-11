/**
 * Аудит 2026-08-20 — `DB_MAINT_ENABLED=false` уводил /readyz в бессрочный 503.
 *
 * `_schedulerLastRun` пишется только изнутри `startMaintScheduler`
 * (db-maint.ts) — на старте и в конце каждого gc-тика. Запускается он только под условием
 * `process.env.DB_MAINT_ENABLED !== "false"` (services.ts). То есть оператор,
 * поставивший документированный в `.env.example` флаг `DB_MAINT_ENABLED`
 * «ВЫКЛЮЧАЕТ ночное
 * обслуживание» и перезапустивший `agent-team`, получал `getSchedulerLastRun()
 * === null` навсегда, а /readyz читал это как `checks.scheduler = "never"` и
 * отвечал 503 на КАЖДЫЙ запрос. Процесс при этом полностью здоров: 12 ботов
 * работают, БД отвечает, Mini App отдаёт данные.
 *
 * Проверка в /readyz означает «интервальный таймер заклинил, GC не идёт». При
 * выключенном планировщике заклинивать нечему — проверка неприменима по
 * определению. Поэтому «метки нет, потому что выключено» отделено от «метки
 * нет, а должна быть».
 *
 * Отказ САМОГО старта (`catch` в services.ts) флаг НЕ ставит: это настоящая
 * поломка, и 503 там по делу. Тест это фиксирует структурно.
 *
 * Почему это не поймали раньше: c-healthz-readyz.test.ts проверяет ветку
 * "never" как ЖЕЛАЕМОЕ поведение, подменяя метку напрямую и ни разу не проходя
 * через развилку DB_MAINT_ENABLED. А t322-env-setup.ts глобально ставит
 * `DB_MAINT_ENABLED ??= "false"` — весь прогон живёт ровно в той конфигурации,
 * где баг проявляется.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_readyz_disabled";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  getSchedulerLastRun,
  setSchedulerLastRunForTests,
  isSchedulerDisabled,
  setSchedulerDisabled,
} from "../lib/db-maint.ts";

let server: MiniappServerHandle;
let baseUrl: string;
let savedLastRun: number | null;
let savedDisabled: boolean;
let prevMetricsToken: string | undefined;
let prevAnthropic: string | undefined;

const METRICS_TOKEN = "test_metrics_token_readyz_disabled";
const AUTH = { authorization: `Bearer ${METRICS_TOKEN}` };

beforeAll(async () => {
  server = await startMiniappServer();
  baseUrl = `http://localhost:${server.port}`;
  savedLastRun = getSchedulerLastRun();
  savedDisabled = isSchedulerDisabled();
  prevMetricsToken = process.env.METRICS_TOKEN;
  prevAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.METRICS_TOKEN = METRICS_TOKEN;
  // /readyz валит ok и без ключа — фиксируем его, чтобы тест говорил ровно про
  // планировщик, а не про соседнюю проверку.
  process.env.ANTHROPIC_API_KEY = "sk-test-anthropic-readyz";
});

afterAll(async () => {
  setSchedulerLastRunForTests(savedLastRun);
  setSchedulerDisabled(savedDisabled);
  if (prevMetricsToken === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = prevMetricsToken;
  if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  await server.stop();
});

describe("выключенное обслуживание не то же самое, что заклинивший таймер", () => {
  test("DB_MAINT_ENABLED=false: /readyz отвечает 200, а не бессрочным 503", async () => {
    setSchedulerLastRunForTests(null);
    setSchedulerDisabled(true);
    const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("причина не теряется: в checks видно 'disabled', а не 'ok'", async () => {
    setSchedulerLastRunForTests(null);
    setSchedulerDisabled(true);
    const body = await (await fetch(`${baseUrl}/readyz`, { headers: AUTH })).json();
    // «disabled» — не «ok»: у оператора остаётся ответ на вопрос «почему не
    // идёт GC», иначе выключенный планировщик стал бы неотличим от рабочего.
    expect(body.checks.scheduler).toBe("disabled");
  });

  test("планировщик включён, но метки нет — по-прежнему 503 'never'", async () => {
    setSchedulerLastRunForTests(null);
    setSchedulerDisabled(false);
    const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
    expect(res.status).toBe(503);
    expect((await res.json()).checks.scheduler).toBe("never");
  });

  test("флаг не перебивает протухшую метку: время всё ещё проверяется", async () => {
    // Выключить обслуживание — не способ заглушить «таймер встал»: если метка
    // ЕСТЬ и она старая, это уже наблюдение о прошлом запуске.
    setSchedulerDisabled(true);
    setSchedulerLastRunForTests(Date.now() - 3 * 60 * 60 * 1000);
    const res = await fetch(`${baseUrl}/readyz`, { headers: AUTH });
    expect(res.status).toBe(503);
    expect((await res.json()).checks.scheduler).toMatch(/^stale-/);
  });

  test("успешный старт планировщика снимает флаг", () => {
    setSchedulerDisabled(true);
    expect(isSchedulerDisabled()).toBe(true);
    // startMaintScheduler ставит метку и сбрасывает флаг; дёргать реальный
    // планировщик в тесте не нужно — важно, что сброс живёт рядом с меткой.
    const src = readFileSync(new URL("../lib/db-maint.ts", import.meta.url), "utf8");
    const boot = src.slice(src.indexOf("_schedulerLastRun = Date.now();"));
    expect(boot.slice(0, 300)).toContain("_schedulerDisabled = false");
  });
});

describe("отказ старта — это не 'выключено'", () => {
  test("флаг ставится только в ветке else, не в catch", () => {
    const src = readFileSync(
      new URL("../orchestrator/services.ts", import.meta.url),
      "utf8",
    );
    const i = src.indexOf("DB_MAINT_ENABLED !== \"false\"");
    expect(i).toBeGreaterThan(0);
    const block = src.slice(i, i + 1600);
    // catch идёт ДО else — проверяем, что setSchedulerDisabled(true) стоит
    // после log.error, то есть в ветке осознанного выключения.
    const catchAt = block.indexOf('log.error("[db-maint] failed to start"');
    const setAt = block.indexOf("setSchedulerDisabled(true)");
    expect(catchAt).toBeGreaterThan(0);
    expect(setAt).toBeGreaterThan(catchAt);
  });
});
