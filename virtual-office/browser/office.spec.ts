import { ROSTER } from "../web/src/roster";
import { test, expect } from "@playwright/test";
test("one-agent vertical slice: 3D, proximity, inspect, direct mock chat, events, 2D", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await page.getByLabel("Качество отображения").selectOption("balanced");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Пишет код", exact: true }).click();
  await page.waitForTimeout(2200);
  await page.screenshot({ path: ".runtime/office-desktop.png" });
  await page.locator("canvas").click({ position: { x: 750, y: 500 } });
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(1450);
  await page.keyboard.up("KeyW");
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(700);
  await page.keyboard.up("KeyA");
  await expect(
    page.getByRole("button", { name: "Поговорить с Backend" }),
  ).toBeVisible();
  await page.keyboard.press("KeyE");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("Восстановление WebSocket-соединения", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Диалог", exact: true }).click();
  await page.getByLabel("Сообщение Backend").fill("Проверь связь");
  await page.getByRole("button", { name: "Отправить ↗", exact: true }).click();
  await expect(
    page.getByText(/Это демонстрационный ответ Backend/).last(),
  ).toBeVisible();
  await page.screenshot({ path: ".runtime/office-chat.png" });
  await page.getByRole("button", { name: "Задача", exact: true }).click();
  await page
    .getByLabel("Описание задачи")
    .fill("Проверить восстановление соединения");
  await page.getByRole("button", { name: "Создать задачу ↗" }).click();
  await expect(
    page.getByText("Демо-задача добавлена. Реальный агент не запускался."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(
    page.getByText("Проверить восстановление соединения", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Тестирует", exact: true }).click();
  await expect(page.locator(".agent-summary")).toContainText("Тестирует");
  await page.getByLabel("Качество отображения").selectOption("low");
  await expect
    .poll(() =>
      page.locator("canvas").evaluate((c) => (c as HTMLCanvasElement).width),
    )
    .toBe(1080);
  await page.getByLabel("Качество отображения").selectOption("2d");
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Открыть рабочее место ↗" }).click();
  await expect(page.getByRole("dialog")).toContainText("TESTING");
  expect(errors).toEqual([]);
});
test("mobile 2D retains readable inspect/chat and no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await page.getByLabel("Качество отображения").selectOption("2d");
  await page.getByRole("button", { name: "Открыть рабочее место ↗" }).click();
  await page.getByRole("button", { name: "Диалог", exact: true }).click();
  await expect(page.getByLabel("Сообщение Backend")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".runtime/office-mobile.png" });
});
test("offline disables commands; reconnect replays missed state without reloading", async ({
  page,
}) => {
  let closeClient = () => {};
  await page.routeWebSocket("**/office/v1/stream?*", (ws) => {
    const server = ws.connectToServer();
    closeClient = () => {
      ws.close({ code: 1011, reason: "test network loss" });
      server.close();
    };
  });
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await page.route("**/office/v1/stream-ticket", (route) => route.abort());
  closeClient();
  await expect(page.getByText("Связь потеряна", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Тестирует", exact: true }),
  ).toBeDisabled();
  await page.request.post("/office/v1/commands", {
    headers: { Origin: "http://127.0.0.1:4317" },
    data: {
      commandId: crypto.randomUUID(),
      agentId: "backend",
      kind: "scenario.set",
      state: "READING",
    },
  });
  await page.unroute("**/office/v1/stream-ticket");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await expect(page.locator(".agent-summary")).toContainText("Читает");
});
test("ambient walk and return to chair never generate productivity events", async ({
  page,
}) => {
  test.setTimeout(65_000);
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await page.getByLabel("Качество отображения").selectOption("low");
  await page.getByRole("button", { name: "Свободен", exact: true }).click();
  await expect(page.locator(".agent-summary")).toContainText("Свободен");
  const seq = await page.locator(".sequence").innerText();
  await expect(page.locator(".ambient")).toContainText("идёт", {
    timeout: 20_000,
  });
  await expect(page.locator(".ambient")).toContainText("смотрит в окно", {
    timeout: 20_000,
  });
  expect(await page.locator(".sequence").innerText()).toBe(seq);
  await page.getByRole("button", { name: "Пишет код", exact: true }).click();
  await expect(page.locator(".ambient")).toContainText("за рабочим столом", {
    timeout: 25_000,
  });
  await expect(page.locator(".agent-summary")).toContainText("Пишет код");
});

test("safe entry does not load WebGL or 3D assets and keeps inspection available", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await expect(page.getByLabel("Качество отображения")).toHaveValue("2d");
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Открыть рабочее место ↗" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    requested.filter((url) =>
      /Scene\.tsx|OfficeCharacter|OfficeEnvironment|\.glb|assets\/materials/.test(
        url,
      ),
    ),
  ).toEqual([]);
});

test("twelve team models and appearance presets load on demand, remain independent and survive reload", async ({
  page,
}) => {
  test.setTimeout(65_000);
  const errors: string[] = [],
    models: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith(".glb")) models.push(r.url().split("/").at(-1)!);
  });
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await page.getByRole("button", { name: "Пишет код", exact: true }).click();
  const sequence = await page.locator(".sequence").innerText();
  await page.getByLabel("Качество отображения").selectOption("low");
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-backend-character",
    "noah",
  );
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-player-character",
    "shirt",
  );
  expect(new Set(models)).toEqual(
    new Set(["shirt.glb", ...ROSTER.map((m) => m.model + ".glb")]),
  );
  await page.locator(".appearance-menu summary").click();
  for (const [player, backend] of [
    ["bob", "suit"],
    ["skirt", "shirt"],
    ["suit", "skirt"],
    ["shirt", "bob"],
  ]) {
    await page.getByLabel("Ваш персонаж", { exact: true }).selectOption(player);
    await page
      .getByLabel("Сотрудник Backend", { exact: true })
      .selectOption(backend);
    await expect(page.locator("canvas")).toHaveAttribute(
      "data-player-character",
      player,
    );
    await expect(page.locator("canvas")).toHaveAttribute(
      "data-backend-character",
      backend,
    );
  }
  expect(await page.locator(".sequence").innerText()).toBe(sequence);
  expect(new Set(models)).toEqual(
    new Set([
      "shirt.glb",
      "bob.glb",
      "suit.glb",
      "skirt.glb",
      ...ROSTER.map((m) => m.model + ".glb"),
    ]),
  );
  await page.getByLabel("Ваш персонаж", { exact: true }).selectOption("skirt");
  await page
    .getByLabel("Сотрудник Backend", { exact: true })
    .selectOption("suit");
  await page.reload();
  await expect(page.getByLabel("Качество отображения")).toHaveValue("2d");
  await page.locator(".appearance-menu summary").click();
  await expect(page.getByLabel("Ваш персонаж", { exact: true })).toHaveValue(
    "skirt",
  );
  await expect(
    page.getByLabel("Сотрудник Backend", { exact: true }),
  ).toHaveValue("suit");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByLabel("Сотрудник Backend", { exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("roster roles stay unconnected, typing reaches keys and empty chair stays still", async ({
  page,
}) => {
  test.setTimeout(65_000);
  await page.goto("/");
  await expect(page.getByText("Gateway подключён")).toBeVisible();
  await page.getByRole("button", { name: "Пишет код", exact: true }).click();
  const sequence = await page.locator(".sequence").innerText();
  await page.getByLabel("Качество отображения").selectOption("low");
  await expect
    .poll(
      async () =>
        Number(
          await page.locator("canvas").getAttribute("data-typing-error"),
        ) || 1,
    )
    .toBeLessThan(0.035);
  for (const member of ROSTER.filter((m) => m.id !== "backend")) {
    await page.getByLabel("Команда офиса").selectOption(member.id);
    await expect(page.getByRole("dialog", { name: member.name })).toContainText(
      "Не подключён",
    );
    await page
      .getByRole("button", { name: "Закрыть карточку", exact: true })
      .last()
      .click();
  }
  expect(await page.locator(".sequence").innerText()).toBe(sequence);
  // The summary now stays on the selected role; inspect Backend's own movement.
  await page.getByLabel("Команда офиса").selectOption("backend");
  await page
    .getByRole("button", { name: "Закрыть инспектор", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Свободен", exact: true }).click();
  await expect(page.locator(".ambient")).toContainText("идёт", {
    timeout: 20_000,
  });
  const yaw = await page.locator("canvas").getAttribute("data-chair-yaw");
  await page.waitForTimeout(4000);
  expect(await page.locator("canvas").getAttribute("data-chair-yaw")).toBe(yaw);
});
