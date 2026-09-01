// SEC-6 / T-604: security headers on every Mini App response, tuned so the
// Telegram WebApp embedding (telegram-web-app.js + inline bootstrap + framing
// by Telegram Web) keeps working.
import { test, expect, describe } from "bun:test";
import { SECURITY_HEADERS, applyCorsToResponse } from "../lib/http-utils.ts";

describe("security headers (T-604 / SEC-6)", () => {
  test("exports the expected hardening headers", () => {
    expect(SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["referrer-policy"]).toContain("strict-origin");
    expect(SECURITY_HEADERS["strict-transport-security"]).toContain("max-age=");
    expect(SECURITY_HEADERS["content-security-policy"]).toBeTruthy();
  });

  test("CSP is Telegram-WebApp compatible (won't brick the Mini App)", () => {
    const csp = SECURITY_HEADERS["content-security-policy"];
    expect(csp).toContain("https://telegram.org"); // the WebApp SDK script
    expect(csp).toContain("'unsafe-inline'"); // index.html inline bootstrap
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("web.telegram.org"); // framed by Telegram Web
    expect(csp).toContain("connect-src 'self'"); // API/SSE same-origin
  });

  test("applyCorsToResponse attaches the headers to a response", () => {
    const req = new Request("https://x/api/health");
    const out = applyCorsToResponse(req, new Response("ok"));
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(out.headers.get("strict-transport-security")).toBeTruthy();
    expect(out.headers.get("referrer-policy")).toBeTruthy();
  });

  test("does not clobber a CSP a handler already set", () => {
    const req = new Request("https://x/");
    const resp = new Response("ok", {
      headers: { "content-security-policy": "custom-policy" },
    });
    const out = applyCorsToResponse(req, resp);
    expect(out.headers.get("content-security-policy")).toBe("custom-policy");
  });
});
