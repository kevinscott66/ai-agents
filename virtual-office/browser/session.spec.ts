import { test, expect } from "@playwright/test";
import { ROSTER } from "../web/src/roster";
test("restores persistent cookie after reload and recreated context; logout removes it", async ({
  browser,
  baseURL,
}) => {
  const cookie = "office-test-session";
  const wire = async (context: any) => {
    await context.route("**/api/web/**", async (route: any) => {
      const path = new URL(route.request().url()).pathname.split(
        "/api/web/",
      )[1];
      const cookies = await context.cookies();
      if (path === "session/pair") {
        await context.addCookies([
          {
            name: cookie,
            value: "test-only",
            url: baseURL!,
            httpOnly: true,
            sameSite: "Strict",
            expires: Date.now() / 1000 + 2592000,
          },
        ]);
        return route.fulfill({ json: { authenticated: true } });
      }
      if (path === "session/logout") {
        await context.clearCookies();
        return route.fulfill({ json: { ok: true } });
      }
      if (!cookies.some((c: any) => c.name === cookie))
        return route.fulfill({ status: 401, json: { error: "unauthorized" } });
      if (path === "office")
        return route.fulfill({
          json: {
            source: "agent-team",
            scope: "owner-execution",
            agents: ROSTER.map((m) => ({
              agentId: m.id,
              name: m.role,
              available: true,
              state: "IDLE",
              runId: null,
              updatedAt: null,
              conversationId: null,
            })),
          },
        });
      return route.fulfill({ json: { authenticated: true } });
    });
  };
  let context = await browser.newContext();
  await wire(context);
  let page = await context.newPage();
  await page.goto(baseURL!);
  await page.getByRole("button", { name: "Демо · подключить агентов" }).click();
  await page.getByLabel("Код подключения").fill("a".repeat(32));
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(
    page.getByText("Реальная система подключена", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain(cookie);
  await page.reload();
  await page.getByRole("button", { name: "Демо · подключить агентов" }).click();
  await expect(
    page.getByText("Реальная система подключена", { exact: true }),
  ).toBeVisible();
  const state = await context.storageState();
  await context.close();
  context = await browser.newContext({ storageState: state });
  await wire(context);
  page = await context.newPage();
  await page.goto(baseURL!);
  await page.getByRole("button", { name: "Демо · подключить агентов" }).click();
  await expect(
    page.getByText("Реальная система подключена", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Выйти на этом устройстве" }).click();
  await expect(page.getByLabel("Код подключения")).toBeVisible();
  expect((await context.cookies()).some((c) => c.name === cookie)).toBe(false);
  await context.close();
});

test("browser accepts Secure HttpOnly host cookie and sends it after profile restoration", async ({
  browser,
}) => {
  const origin = "https://office-session.test";
  const wire = async (context: any) =>
    context.route(origin + "/**", async (route: any) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Session boundary test</title>",
        });
      if (path === "/api/web/session/pair")
        return route.fulfill({
          json: { authenticated: true },
          headers: {
            "Set-Cookie":
              "__Host-AgentOffice=" +
              "a".repeat(64) +
              "; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict",
          },
        });
      return route.fulfill({
        json: { received: route.request().headers().cookie ?? "" },
      });
    });
  let context = await browser.newContext();
  await wire(context);
  let page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(() =>
    fetch("/api/web/session/pair", {
      method: "POST",
      credentials: "same-origin",
    }),
  );
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const state = await context.storageState();
  expect(state.cookies[0]).toMatchObject({
    name: "__Host-AgentOffice",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
  });
  await context.close();
  context = await browser.newContext({ storageState: state });
  await wire(context);
  page = await context.newPage();
  await page.goto(origin);
  const result = await page.evaluate(
    async () =>
      await (
        await fetch("/api/web/session", { credentials: "same-origin" })
      ).json(),
  );
  expect(result.received).toBe("__Host-AgentOffice=" + "a".repeat(64));
  await context.close();
});
