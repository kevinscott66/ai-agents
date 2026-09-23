import { test, expect } from "@playwright/test";
import { ROSTER, seatNumber } from "../web/src/roster";
test("paired live office routes all roles, preserves request ID on uncertain delivery and does not expose token", async ({
  page,
}) => {
  const token = "a".repeat(64),
    code = "b".repeat(32);
  let connected = true,
    failOnce = true;
  const turns: any[] = [],
    dialogs: Record<string, string> = {},
    histories: Record<string, any[]> = {};
  await page.route("**/api/web/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/web/", "");
    const body = request.postDataJSON();
    if (path === "pair")
      return route.fulfill({ json: { token, userId: "owner" } });
    expect(request.headers().authorization).toBe("Bearer " + token);
    if (!connected)
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    if (path === "office")
      return route.fulfill({
        json: {
          source: "agent-team",
          scope: "office-native-turns",
          agents: ROSTER.map((m) => ({
            agentId: m.id,
            name: m.role,
            available: true,
            state: m.id === "frontend" ? "THINKING" : "IDLE",
            runId: null,
            updatedAt: null,
            conversationId: dialogs[m.id] ?? null,
          })),
        },
      });
    if (path === "conversations") {
      histories[body.id] = [];
      return route.fulfill({ json: { conversation: { id: body.id } } });
    }
    if (path.endsWith("/approvals"))
      return route.fulfill({ json: { approvals: [] } });
    if (path.startsWith("conversations/"))
      return route.fulfill({
        json: { messages: histories[path.split("/")[1]] ?? [] },
      });
    if (path === "turns") {
      turns.push(body);
      dialogs[body.agentKey] = body.conversationId;
      histories[body.conversationId] = [
        { role: "user", text: body.text },
        {
          role: "assistant",
          text: "Ответ " + body.agentKey,
          agentKey: body.agentKey,
        },
      ];
      if (failOnce) {
        failOnce = false;
        return route.abort();
      }
      return route.fulfill({
        status: 202,
        json: { id: body.id, status: "running", replies: [] },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Демо · подключить агентов" }).click();
  await page.getByLabel("Код подключения").fill(code);
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(
    page.getByText("Реальная система подключена", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Команда офиса").selectOption("frontend");
  await page.getByLabel("Сообщение реальному агенту").fill("Проверь интерфейс");
  await page.getByRole("button", { name: "Отправить поручение" }).click();
  await expect(
    page.getByRole("button", { name: "Проверить / повторить тот же запрос" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить / повторить тот же запрос" })
    .click();
  expect(turns).toHaveLength(2);
  expect(turns[1]).toEqual(turns[0]);
  expect(turns[0].agentKey).toBe("frontend");
  await expect(page.getByText("Ответ frontend", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Закрыть живой диалог", exact: true })
    .last()
    .click();
  for (const m of ROSTER) {
    await page.getByLabel("Команда офиса").selectOption(m.id);
    await expect(
      page.getByRole("dialog", { name: "Диалог: " + m.name }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Закрыть живой диалог", exact: true })
      .last()
      .click();
    await expect(page.getByLabel("Команда офиса")).toHaveValue(m.id);
    await expect(page.locator(".agent-card strong")).toHaveText(
      m.name + " / " + m.role,
    );
    await expect(page.locator(".card-overline")).toContainText(
      seatNumber(m.id) + " / 12",
    );
    await expect(page.locator(".agent-card small")).toHaveText(
      m.id === "frontend" ? "Готовит ответ" : "Свободен",
    );
    await expect(page.locator(".flat-card h1")).toHaveText(
      m.name + " / " + m.role,
    );
    await expect(page.locator(".flat-card .eyebrow")).toContainText(
      seatNumber(m.id),
    );
    await page.locator(".agent-summary").click();
    await expect(
      page.getByRole("dialog", { name: "Диалог: " + m.name }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Закрыть живой диалог", exact: true })
      .last()
      .click();
  }
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(token);
  await page.getByRole("link", { name: "DOBROPALM Office" }).click();
  await expect(
    page.getByText("Реальная система подключена", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Код подключения")).toHaveCount(0);
  connected = false;
  await expect(
    page.getByText("Нет связи с системой", { exact: true }),
  ).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".connection")).toContainText(
    "Система не подключена",
  );
  await expect(page.locator(".agent-card small")).toHaveText("Нет связи");
  await page.getByRole("button", { name: "Отключить", exact: true }).click();
  await expect(page.getByLabel("Код подключения")).toBeVisible();
});

test("disconnect during an unresolved send permits a fresh session", async ({
  page,
}) => {
  let release: () => void = () => {};
  const hold = new Promise<void>((r) => (release = r));
  let sending = false;
  await page.route("**/api/web/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/api/web/")[1],
      body = route.request().postDataJSON();
    if (path === "pair")
      return route.fulfill({ json: { token: "c".repeat(64) } });
    if (path === "office")
      return route.fulfill({
        json: {
          source: "agent-team",
          scope: "office-native-turns",
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
    if (path === "conversations")
      return route.fulfill({ json: { conversation: { id: body.id } } });
    if (path === "turns") {
      sending = true;
      await hold;
      return route
        .fulfill({ status: 202, json: { status: "running" } })
        .catch(() => {});
    }
    return route.fulfill({ json: { messages: [], approvals: [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Демо · подключить агентов" }).click();
  const pair = async () => {
    await page.getByLabel("Код подключения").fill("d".repeat(32));
    await page.getByRole("button", { name: "Подключить", exact: true }).click();
    await expect(
      page.getByText("Реальная система подключена", { exact: true }),
    ).toBeVisible();
  };
  await pair();
  await page.getByLabel("Команда офиса").selectOption("backend");
  await page.getByLabel("Сообщение реальному агенту").fill("hello");
  await page.getByRole("button", { name: "Отправить поручение" }).click();
  await expect.poll(() => sending).toBe(true);
  await page
    .getByRole("button", { name: "Закрыть живой диалог", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Отключить", exact: true }).click();
  release();
  await pair();
  await page.getByLabel("Команда офиса").selectOption("backend");
  await expect(page.getByLabel("Сообщение реальному агенту")).toBeEnabled();
});
