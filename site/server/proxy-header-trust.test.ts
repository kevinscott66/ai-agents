import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientIpKey } from "./index.ts";

const CADDYFILE = readFileSync(
  join(import.meta.dir, "..", "..", "deploy", "Caddyfile"),
  "utf8",
);

describe("trusted proxy client IP contract", () => {
  test("Caddy overwrites forwarded identity instead of appending client input", () => {
    expect(CADDYFILE).toContain("header_up X-Real-IP {remote_host}");
    expect(CADDYFILE).toContain("header_up X-Forwarded-For {remote_host}");
    expect(CADDYFILE).not.toContain("{http.request.header.X-Forwarded-For}");
  });

  test("the application ignores forwarded headers from an untrusted peer", () => {
    expect(clientIpKey("198.51.100.7", "203.0.113.9")).toBe(
      "ip:203.0.113.9",
    );
  });

  test("the loopback proxy path uses the overwritten rightmost client value", () => {
    expect(clientIpKey("198.51.100.7", "127.0.0.1")).toBe("ip:198.51.100.7");
  });
});
