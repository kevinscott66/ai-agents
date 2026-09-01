/**
 * Аудит 2026-08-12: `/api/health` отдавал наружу тот самый факт, который
 * 2026-08-08 убрали из `/readyz`.
 *
 * Тогда решение было записано в коде явно: `/readyz` отвечает без
 * аутентификации (иначе systemd и nginx им не воспользуются), Mini App висит
 * на публичном https://agents.example.com:8443, поэтому наружу уходит
 * только `{ ok }`, а `checks` — предъявителю METRICS_TOKEN. В списке `checks`
 * первым пунктом стоял `mac_bridge`.
 *
 * Ручка `/api/health` — обратно-совместимый алиас того же зонда, и она
 * осталась нетронутой:
 *   return json({ ok: true, ts: Date.now(), mac_online: isMacOnline() });
 * То есть ровно тот же сигнал («поднят ли мост к Mac владельца») по-прежнему
 * читал кто угодно из интернета — одним GET, без заголовков. Хардening
 * применили к одному из двух путей к одному и тому же факту.
 *
 * Инвариант: код ответа и `ok`/`ts` не меняются ни для кого (на них построены
 * решения о рестарте), а `mac_online` видит только тот, кто уже аутентифицирован
 * — валидным initData (так ходит сам Mini App) или METRICS_TOKEN (так ходит
 * мониторинг, как в /metrics и /readyz).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_health_mac";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_health_mac";
const USER_ID = 88210;
const METRICS_TOKEN = "metrics-token-for-health-test";

let server: MiniappServerHandle;
let base: string;
let prevMetricsToken: string | undefined;

beforeAll(() => {
  prevMetricsToken = process.env.METRICS_TOKEN;
  process.env.METRICS_TOKEN = METRICS_TOKEN;
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server.stop();
    _resetRateLimiter();
  } finally {
    if (prevMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prevMetricsToken;
  }
});

function initData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-health-mac",
    user: JSON.stringify({ id: USER_ID, username: "h", first_name: "H" }),
  });
}

describe("/api/health — mac_online только аутентифицированным", () => {
  test("аноним получает 200 и ok/ts, но не mac_online", async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("number");
    expect("mac_online" in body).toBe(false);
  });

  test("мусорный initData — тоже аноним", async () => {
    const r = await fetch(`${base}/api/health`, {
      headers: { "x-telegram-init-data": "user=%7B%22id%22%3A1%7D&hash=deadbeef" },
    });
    expect(r.status).toBe(200);
    expect("mac_online" in (await r.json())).toBe(false);
  });

  test("валидный initData видит mac_online", async () => {
    const r = await fetch(`${base}/api/health`, {
      headers: { "x-telegram-init-data": initData() },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.mac_online).toBe("boolean");
  });

  test("METRICS_TOKEN видит mac_online — как /metrics и /readyz", async () => {
    const r = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(typeof (await r.json()).mac_online).toBe("boolean");
  });

  test("чужой Bearer не открывает поле", async () => {
    const r = await fetch(`${base}/api/health`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(r.status).toBe(200);
    expect("mac_online" in (await r.json())).toBe(false);
  });

  test("/healthz остаётся минимальным зондом без mac_online", async () => {
    const r = await fetch(`${base}/healthz`, {
      headers: { "x-telegram-init-data": initData() },
    });
    expect(r.status).toBe(200);
    expect("mac_online" in (await r.json())).toBe(false);
  });
});
