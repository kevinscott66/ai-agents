/**
 * Аудит 2026-08-20: JSON-ответы Mini App кэшируемы, а `Vary` их не защищал.
 *
 * Один и тот же URL отдаёт разное в зависимости от credential'а — намеренно:
 * `/readyz` предъявителю METRICS_TOKEN отдаёт `checks`, остальным `{ok}`;
 * `/api/health` добавляет `mac_online` только своим; `/api/actions` показывает
 * админу `payload`/`result`, а зрителю «(скрыто…)». Всё это GET+200, то есть
 * кэшируемо по умолчанию, а `Vary` называл только Origin и Accept-Encoding.
 * Общему кэшу (перед nginx стоит Cloudflare) этого достаточно, чтобы отдать
 * анониму ответ, сложенный для админа: ключ совпал.
 *
 * Вторая половина — ветка gzip в applyCompressionAndEtag делала
 * `headers.set("vary", "Accept-Encoding")`, то есть ЗАТИРАЛА всё, что стояло
 * до неё. Origin возвращал следом applyCorsToResponse, а заголовки
 * credential'а — уже никто. Без этой правки первая половина держится ровно до
 * первого ответа больше килобайта.
 */
import { describe, expect, test } from "bun:test";
import {
  applyCompressionAndEtag,
  applyCorsToResponse,
  json,
  mergeVary,
} from "../lib/http-utils";

function varyTokens(res: Response): string[] {
  return (res.headers.get("vary") ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

describe("json(): ответ не уходит в общий кэш", () => {
  test("undefined сериализуется как валидный JSON null", async () => {
    const response = json(undefined);
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("null");
  });

  test("cache-control запрещает общее хранение", () => {
    const cc = json({ ok: true }).headers.get("cache-control") ?? "";
    expect(cc).toContain("private");
    expect(cc).toContain("no-store");
  });

  test("Vary называет оба заголовка credential'а и Origin", () => {
    const v = varyTokens(json({ ok: true }));
    expect(v).toContain("origin");
    expect(v).toContain("x-telegram-init-data");
    expect(v).toContain("authorization");
  });

  test("Vary не дублирует Origin, который уже поставил corsHeaders", () => {
    const v = varyTokens(json({ ok: true }, 200, {}, "https://example.org"));
    expect(v.filter((t) => t === "origin")).toHaveLength(1);
  });

  test("extraHeaders со своим Vary дополняется, а не затирается", () => {
    const v = varyTokens(json({ ok: true }, 200, { vary: "X-Custom" }));
    expect(v).toContain("x-custom");
    expect(v).toContain("x-telegram-init-data");
    expect(v).toContain("authorization");
  });

  test("ошибочные ответы кэшируются не охотнее успешных", () => {
    const res = json({ error: "нет доступа" }, 403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(varyTokens(res)).toContain("authorization");
  });
});

describe("gzip не должен терять Vary", () => {
  // Больше GZIP_MIN_BYTES (1024), иначе ветка сжатия просто не сработает.
  const big = { rows: Array.from({ length: 200 }, (_, i) => `строка-${i}`) };
  const gz = new Request("http://x/api/actions", {
    headers: { "accept-encoding": "gzip" },
  });

  test("тело действительно сжимается (иначе тест ничего не проверяет)", async () => {
    const out = await applyCompressionAndEtag(gz, json(big));
    expect(out.headers.get("content-encoding")).toBe("gzip");
  });

  test("после сжатия credential-токены на месте", async () => {
    const out = await applyCompressionAndEtag(gz, json(big));
    const v = varyTokens(out);
    expect(v).toContain("accept-encoding");
    expect(v).toContain("x-telegram-init-data");
    expect(v).toContain("authorization");
  });

  test("cache-control переживает сжатие", async () => {
    const out = await applyCompressionAndEtag(gz, json(big));
    expect(out.headers.get("cache-control")).toContain("no-store");
  });

  test("и после applyCorsToResponse поверх сжатия ничего не потеряно", async () => {
    const withOrigin = new Request("http://x/api/actions", {
      headers: { "accept-encoding": "gzip", origin: "https://example.org" },
    });
    const out = applyCorsToResponse(
      withOrigin,
      await applyCompressionAndEtag(withOrigin, json(big)),
    );
    const v = varyTokens(out);
    for (const t of ["origin", "accept-encoding", "x-telegram-init-data", "authorization"]) {
      expect(v).toContain(t);
    }
  });
});

describe("mergeVary", () => {
  test("на пустых заголовках создаёт список", () => {
    const h = new Headers();
    mergeVary(h, "Origin");
    expect(h.get("vary")).toBe("Origin");
  });

  test("дописывает, сохраняя прежние токены", () => {
    const h = new Headers({ vary: "Accept-Encoding" });
    mergeVary(h, "Origin");
    expect(h.get("vary")).toBe("Accept-Encoding, Origin");
  });

  test("повтор в другом регистре не создаёт второй токен", () => {
    const h = new Headers({ vary: "origin" });
    mergeVary(h, "Origin", "ORIGIN");
    expect(h.get("vary")).toBe("origin");
  });

  test("без токенов и без прежнего значения заголовок не появляется", () => {
    const h = new Headers();
    mergeVary(h);
    expect(h.get("vary")).toBeNull();
  });
});
