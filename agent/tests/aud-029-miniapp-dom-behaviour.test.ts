/**
 * AUD-029: поведение доски задач Mini App в DOM, а не текст исходников.
 *
 * Приёмка пункта: тест ловит (1) отсутствие фокуса в диалоге, (2) потерю
 * черновика новой задачи и (3) недоступность старой страницы списка. Всё
 * проверяется рендером настоящих компонентов в happy-dom (tests/_dom.ts):
 * клики, клавиши, document.activeElement. Сервер — подменённый fetch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { button, installDom, key, settle, type, uninstallDom, waitFor } from "./_dom.ts";

installDom();
// Тот же экземпляр Preact, что у компонентов (их "react" — это preact/compat из miniapp).
const { h, render } = await import("../miniapp/node_modules/preact");
const { useState } = await import("../miniapp/node_modules/preact/hooks");
const { Dialog } = await import("../miniapp/src/components/Dialog.tsx");
const Tasks = (await import("../miniapp/src/pages/Tasks.tsx")).default;

type Json = Record<string, unknown>;
interface Call { method: string; path: string; query: URLSearchParams; body: Json | null }
let calls: Call[] = [];
let route: (c: Call) => { status: number; body: Json } = () => ({ status: 404, body: { error: "not_found" } });
const realFetch = globalThis.fetch;

function task(n: number): Json {
  return {
    id: `t${n}`, title: `Задача ${n}`, status: "pending", assignee: "backend", chat_id: 1,
    created_at: 1_700_000_000_000 - n, updated_at: 1_700_000_000_000 - n, input: null, output: null,
  };
}

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "https://miniapp.test/");
    const c: Call = {
      method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(c);
    const r = route(c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await uninstallDom();
});

let root: HTMLElement;
function mount(node: unknown): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(node as never, root);
  return root;
}
afterEach(() => {
  render(null, root);
  root.remove();
  calls = [];
});

describe("Dialog: фокус и клавиатура", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return h("div", null,
      h("button", { id: "opener", onClick: () => setOpen(true) }, "Открыть"),
      open && h(Dialog, {
        title: "Окно", onClose: () => setOpen(false),
        children: [h("input", { id: "first" }), h("button", { id: "last" }, "Готово")],
      }));
  }

  test("при открытии фокус внутри диалога, Tab ходит по кругу, Escape закрывает и возвращает фокус", async () => {
    const el = mount(h(Harness, null));
    const opener = el.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    opener.click();
    await waitFor(() => document.activeElement?.id === "first", "фокус в диалоге");
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Окно");
    expect(document.activeElement?.id).toBe("first");

    el.querySelector<HTMLButtonElement>("#last")!.focus();
    key(document.activeElement!, "Tab");
    expect(document.activeElement?.id).toBe("first");
    key(document.activeElement!, "Tab", true);
    expect(document.activeElement?.id).toBe("last");

    key(document.activeElement!, "Escape");
    await waitFor(() => el.querySelector('[role="dialog"]') === null, "диалог закрыт");
    await waitFor(() => document.activeElement === opener, "фокус вернулся");
    expect(document.activeElement).toBe(opener);
  });
});

describe("Tasks: черновик и страницы списка", () => {
  test("ошибка создания не теряет черновик, отмена и повторное открытие тоже", async () => {
    route = (c) => {
      if (c.path === "/api/tasks" && c.method === "GET") return { status: 200, body: { tasks: [task(1)], truncated: false, nextOffset: null } };
      if (c.path === "/api/tasks" && c.method === "POST") return { status: 500, body: { error: "db_down" } };
      if (c.path === "/api/agents") return { status: 200, body: { agents: [] } };
      if (c.path === "/api/autonomy") return { status: 200, body: { isAdmin: true, admin: true, level: "auto" } };
      return { status: 404, body: { error: "not_found" } };
    };
    const el = mount(h(Tasks, null));
    await waitFor(() => el.textContent!.includes("Задача 1"), "список задач");
    button(el, "Новая задача").click();
    const title = () => el.querySelector<HTMLInputElement>("#new-task-title");
    await waitFor(() => document.activeElement === title() && title() !== null, "фокус на названии");
    expect(document.activeElement).toBe(title());
    type(title()!, "Проверить бэкапы");
    type(el.querySelector<HTMLInputElement>("#new-task-chat")!, "42");
    await settle();

    button(el, "Создать").click();
    await waitFor(() => calls.some((c) => c.method === "POST"), "POST задачи");
    await settle(10);
    expect(calls.some((c) => c.method === "POST" && c.body?.title === "Проверить бэкапы")).toBe(true);
    expect(title()?.value).toBe("Проверить бэкапы");

    key(el.querySelector('[role="dialog"]')!, "Escape");
    await waitFor(() => title() === null, "диалог закрыт");
    button(el, "Новая задача").click();
    await waitFor(() => title() !== null, "диалог снова открыт");
    expect(title()?.value).toBe("Проверить бэкапы");
  });

  test("«Показать ещё» догружает вторую страницу и сохраняет первую", async () => {
    route = (c) => {
      if (c.path === "/api/tasks" && c.method === "GET") {
        const offset = Number(c.query.get("offset") ?? 0);
        const limit = Number(c.query.get("limit") ?? 100);
        const all = Array.from({ length: 150 }, (_, i) => task(i + 1));
        const page = all.slice(offset, offset + limit);
        const truncated = offset + limit < all.length;
        return { status: 200, body: { tasks: page, truncated, nextOffset: truncated ? offset + limit : null } };
      }
      if (c.path === "/api/agents") return { status: 200, body: { agents: [] } };
      if (c.path === "/api/autonomy") return { status: 200, body: { isAdmin: true, admin: true, level: "auto" } };
      return { status: 404, body: { error: "not_found" } };
    };
    const el = mount(h(Tasks, null));
    const titles = () => Array.from(el.querySelectorAll(".task-open"), (b) => b.textContent ?? "");
    await waitFor(() => titles().length > 0, "первая страница");
    expect(titles().some((t) => t.includes("Задача 100"))).toBe(true);
    expect(titles().some((t) => t.includes("Задача 150"))).toBe(false);

    button(el, "Показать ещё").click();
    await waitFor(() => titles().some((t) => t.includes("Задача 150")), "вторая страница");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/tasks" && c.query.get("offset") === "100")).toBe(true);
    expect(titles().some((t) => /Задача 1(?!\d)/.test(t))).toBe(true);
    expect(titles().some((t) => t.includes("Задача 150"))).toBe(true);
    expect(el.textContent).not.toContain("Показать ещё");
  });
});
