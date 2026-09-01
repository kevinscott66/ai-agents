import { describe, expect, test } from "bun:test";
import { formatApiError } from "../miniapp/src/lib/api.ts";
import { readFileSync } from "node:fs";

describe("Mini App launch diagnostics", () => {
  test("maps auth, access, route and network failures to actionable messages", () => {
    expect(formatApiError({ status: 401 })).toContain("Telegram");
    expect(formatApiError({ status: 403 })).toContain("доступа");
    expect(formatApiError({ status: 404 })).toContain("Маршрут");
    expect(formatApiError({ status: 503 })).toContain("Сервер");
    expect(formatApiError(new Error("Failed to fetch"))).toContain("DNS");
    expect(formatApiError(new Error("redacted-example"))).not.toContain("redacted-example");
  });

  test("keeps the launch guard and boot timeout in source", () => {
    const dashboard = readFileSync(new URL("../miniapp/src/pages/Dashboard.tsx", import.meta.url), "utf8");
    const html = readFileSync(new URL("../miniapp/index.html", import.meta.url), "utf8");
    expect(dashboard).toContain("telegramLaunchState");
    expect(dashboard).toContain("Откройте панель кнопкой Mini App в Telegram");
    expect(html).toContain("8000");
    expect(html).toContain("Интерфейс не загрузился");
  });

  test("does not render raw runtime errors into the Mini App", () => {
    const boundary = readFileSync(new URL("../miniapp/src/components/ErrorBoundary.tsx", import.meta.url), "utf8");
    const main = readFileSync(new URL("../miniapp/src/main.tsx", import.meta.url), "utf8");
    expect(boundary).not.toContain("this.state.error.message");
    expect(main).not.toContain("MOUNT ERROR");
  });
});
