import { test, expect } from "@playwright/test";
import { ROSTER } from "../web/src/roster";
test("live chat statuses animate roles and stop on connection loss", async ({
  page,
}) => {
  test.setTimeout(90000);
  let state = "THINKING",
    connected = true;
  await page.route("**/api/web/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/pair"))
      return route.fulfill({ json: { token: "a".repeat(64) } });
    if (!connected)
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    return route.fulfill({
      json: {
        source: "agent-team",
        scope: "owner-execution",
        briefingTo: state === "THINKING" ? ["backend", "frontend"] : [],
        agents: ROSTER.map((m) => ({
          agentId: m.id,
          name: m.role,
          available: true,
          state,
          runId: null,
          updatedAt: null,
          conversationId: null,
        })),
      },
    });
  });
  await page.goto(process.env.OFFICE_TEST_URL ?? "/");
  await page.getByRole("button", { name: "Демо · подключить агентов" }).click();
  await page.getByLabel("Код подключения").fill("b".repeat(32));
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await page.getByLabel("Качество отображения").selectOption("low");
  for (const member of ROSTER)
    await expect(page.locator("canvas")).toHaveAttribute(
      `data-activity${member.id}`,
      "working",
      { timeout: 45000 },
    );
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-conversationorchestrator",
    "speaking",
  );
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-conversationbackend",
    "listening",
  );
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-conversationfrontend",
    "listening",
  );
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-conversationqa",
    "none",
  );
  state = "WAITING";
  for (const member of ROSTER)
    await expect(page.locator("canvas")).toHaveAttribute(
      `data-activity${member.id}`,
      "waiting",
      { timeout: 15000 },
    );
  state = "DONE";
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-activityfrontend",
    "done",
    { timeout: 15000 },
  );
  connected = false;
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-activityfrontend",
    "idle",
    { timeout: 20000 },
  );
});
