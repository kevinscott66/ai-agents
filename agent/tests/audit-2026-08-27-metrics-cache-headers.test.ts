/**
 * Аудит 2026-08-27: /metrics — последняя кэшируемая ручка, зависящая от
 * credential'а.
 *
 * Аудит 2026-08-20 закрыл эту дыру для JSON-ответов: `json()` ставит
 * `private, no-store` и перечисляет в `Vary` оба заголовка credential'а.
 * Закрыл он её для /readyz, /api/health и /api/actions — то есть для ручек,
 * где разница между привилегированным и анонимным ответом это одно лишнее
 * поле. Мимо прошла та, где разница максимальная: /metrics без Bearer отдаёт
 * 401, а с Bearer — всю телеметрию процесса (размеры таблиц, глубины очередей,
 * время последнего прогона планировщика). Она единственная не идёт через
 * `json()`, поэтому правку 2026-08-20 не получила.
 *
 * Измерено до правки: GET /metrics с валидным Bearer → 200, `cache-control`
 * отсутствует, `vary: Origin`, ETag проставлен. Для общего кэша (перед nginx
 * с 2026-08-19 стоит Cloudflare) это разрешение сложить ответ мониторинга и
 * отдать его следующему запросу на тот же URL — ключ совпал, про Authorization
 * кэшу никто не сказал.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_metrics_cache";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { applyCompressionAndEtag } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_metrics_cache";
const VALID_TOKEN = "metrics-token-cache-audit";

let server: MiniappServerHandle;
let base: string;
let prevMetricsToken: string | undefined;

beforeAll(() => {
  prevMetricsToken = process.env.METRICS_TOKEN;
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [1],
    adminUserIds: [1],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server.stop();
  } finally {
    if (prevMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prevMetricsToken;
  }
});

function varyTokens(res: Response): string[] {
  return (res.headers.get("vary") ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

async function get(headers: Record<string, string> = {}): Promise<Response> {
  const r = await fetch(`${base}/metrics`, { headers });
  await r.text(); // тело не нужно, но поток закрыть надо
  return r;
}

describe("/metrics не уходит в общий кэш", () => {
  test("200 с валидным Bearer: cache-control запрещает хранение", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await get({ authorization: `Bearer ${VALID_TOKEN}` });
      expect(r.status).toBe(200);
      const cc = r.headers.get("cache-control") ?? "";
      expect(cc).toContain("private");
      expect(cc).toContain("no-store");
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("200 называет Authorization в Vary — иначе ключ кэша не различает предъявителя", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await get({ authorization: `Bearer ${VALID_TOKEN}` });
      expect(varyTokens(r)).toContain("authorization");
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("Origin из applyCorsToResponse не вытесняет Authorization и не дублируется", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await get({ authorization: `Bearer ${VALID_TOKEN}` });
      const v = varyTokens(r);
      expect(v).toContain("origin");
      expect(v).toContain("authorization");
      expect(v.filter((t) => t === "origin")).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("401 без токена: отказ кэшируется не охотнее успеха", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await get();
      expect(r.status).toBe(401);
      expect(r.headers.get("cache-control") ?? "").toContain("no-store");
      expect(varyTokens(r)).toContain("authorization");
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("503 при незаданном METRICS_TOKEN тоже помечен", async () => {
    const prev = process.env.METRICS_TOKEN;
    delete process.env.METRICS_TOKEN;
    try {
      const r = await get();
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control") ?? "").toContain("no-store");
      expect(varyTokens(r)).toContain("authorization");
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("ответ действительно кэшируем по умолчанию: ETag на месте", async () => {
    // Без этой проверки предыдущие тесты доказывают лишь наличие заголовков,
    // а не то, что без них была дыра: 200 с ETag — ровно то, что общий кэш
    // и сохраняет.
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await get({ authorization: `Bearer ${VALID_TOKEN}` });
      expect(r.headers.get("etag")).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });
});

describe("gzip не съедает Vary у text/plain", () => {
  // Тело /metrics в тесте меньше GZIP_MIN_BYTES, так что ветка сжатия на нём
  // не срабатывает — а в проде метрик набирается на килобайты. Проверяем
  // ветку напрямую тем же content-type, что отдаёт ручка.
  test("после сжатия Authorization остаётся в Vary", async () => {
    const body = Array.from(
      { length: 300 },
      (_, i) => `agent_metric_line_${i} ${i}`,
    ).join("\n");
    const src = new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "private, no-store",
        vary: "Authorization",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
    const req = new Request("http://x/metrics", {
      headers: { "accept-encoding": "gzip" },
    });
    const out = await applyCompressionAndEtag(req, src);
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(varyTokens(out)).toContain("authorization");
    expect(out.headers.get("cache-control")).toContain("no-store");
  });
});
