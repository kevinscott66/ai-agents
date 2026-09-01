/**
 * T-320 — GET /metrics Prometheus endpoint.
 *
 * Covers:
 *   - 503 when METRICS_TOKEN unset (fail-closed)
 *   - 401 on missing / wrong bearer
 *   - 200 + sane Prometheus text format on valid bearer
 *   - format sanity: HELP/TYPE lines, expected metric names
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_t320";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startMiniappServer,
  renderMetrics,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  setSchedulerLastRunForTests,
  getSchedulerLastRun,
} from "../lib/db-maint.ts";

const BOT_TOKEN = "test_bot_token_for_t320";
const VALID_TOKEN = "metrics-token-t320";

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
    if (prevMetricsToken === undefined) {
      delete process.env.METRICS_TOKEN;
    } else {
      process.env.METRICS_TOKEN = prevMetricsToken;
    }
  }
});

describe("T-320 /metrics", () => {
  test("503 when METRICS_TOKEN unset (fail-closed)", async () => {
    const prev = process.env.METRICS_TOKEN;
    delete process.env.METRICS_TOKEN;
    try {
      const r = await fetch(`${base}/metrics`);
      expect(r.status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("401 when bearer header missing", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await fetch(`${base}/metrics`);
      expect(r.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("401 when bearer token wrong", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await fetch(`${base}/metrics`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(r.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  test("200 + Prometheus text format on valid bearer", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = VALID_TOKEN;
    try {
      const r = await fetch(`${base}/metrics`, {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(r.status).toBe(200);
      const ctype = r.headers.get("content-type") ?? "";
      expect(ctype).toContain("text/plain");
      const body = await r.text();
      // Format sanity.
      expect(body).toContain("# HELP ");
      expect(body).toContain("# TYPE ");
      expect(body).toContain("agent_team_build_info");
      expect(body).toContain("mac_bridge_connected");
      // At least one metric line — each metric block ends with a newline.
      expect(body.length).toBeGreaterThan(0);
      // Every non-comment / non-empty line should have name + space + numeric value.
      const dataLines = body
        .split("\n")
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      expect(dataLines.length).toBeGreaterThan(0);
      for (const line of dataLines) {
        // name{labels?} value
        expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})? -?\d+(\.\d+)?$/);
      }
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });
});

describe("T-320 scheduler_last_run_age_seconds gauge", () => {
  let prevLastRun: number | null;
  beforeAll(() => {
    prevLastRun = getSchedulerLastRun();
  });
  afterAll(() => {
    setSchedulerLastRunForTests(prevLastRun);
  });

  test("emits the gauge with a non-negative age once a run is recorded", () => {
    setSchedulerLastRunForTests(Date.now() - 5000);
    const body = renderMetrics();
    expect(body).toContain("scheduler_last_run_age_seconds");
    const line = body
      .split("\n")
      .find((l) => l.startsWith("scheduler_last_run_age_seconds "));
    expect(line).toBeDefined();
    const value = Number(line!.split(" ")[1]);
    expect(value).toBeGreaterThanOrEqual(4); // ~5s elapsed, allow scheduling slack
  });

  test("omits the gauge entirely when the scheduler has never run", () => {
    setSchedulerLastRunForTests(null);
    const body = renderMetrics();
    expect(body).not.toContain("scheduler_last_run_age_seconds");
  });
});
