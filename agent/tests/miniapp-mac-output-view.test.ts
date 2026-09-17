/**
 * Аудит 2026-08-14: панель «Вывод сессии» не показывала вывод никогда.
 *
 * Она читала только карту живых чанков, набиваемую подпиской на `mac.output`.
 * Такого события не существует: по всему репозиторию имя встречается ровно
 * дважды — в самой подписке и в тесте, проверяющем форму придуманного
 * объекта (c36-mac.test.ts). Сервер не шлёт его ниоткуда, поэтому карта
 * оставалась пустой всегда, и панель показывала «Ожидание вывода… (SSE
 * события mac.output)» — вечно.
 *
 * Настоящий вывод при этом лежал рядом и был загружен: `toMacSession` кладёт
 * его в `output` из `agent_actions.result.output`. То есть страница держала
 * текст в памяти и рисовала над ним фразу про ожидание.
 *
 * Второй слой находки: выбрать можно было только БЕГУЩУЮ сессию — карточки
 * истории не имели обработчика клика вовсе. А вывод есть ровно у
 * завершившихся. Даже почини панель, дотянуться до неё было бы нечем.
 *
 * Инвариант: если вывод загружен — он на экране; если его нет — сказано,
 * почему именно (скрыт, ещё идёт, не сохранён), а не одно на все случаи.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  macOutputView,
  REDACTED_NOTE,
  toMacSession,
  type MacSession,
} from "../miniapp/src/lib/mac-session.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Mac.tsx"),
  "utf8",
);

function session(over: Partial<MacSession> = {}): MacSession {
  return {
    id: "act_1",
    project: "ai-agents",
    mode: "ask",
    status: "completed",
    createdAt: 1_760_000_000_000,
    output: [],
    prompt: "почини тесты",
    redacted: false,
    ...over,
  };
}

describe("сохранённый вывод доходит до экрана", () => {
  test("вывод завершившейся сессии показывается, а не «ожидание»", () => {
    const v = macOutputView(session({ output: ["PONG\n", "code=0"] }));
    expect(v.lines).toEqual(["PONG\n", "code=0"]);
    expect(v.note).toBeNull();
  });

  test("вывод берётся ровно из agent_actions.result.output", () => {
    // Полный путь: строка БД → toMacSession → панель.
    const s = toMacSession({
      id: "act_2",
      agent_key: "orchestrator",
      action_type: "MAC_RUN_CLAUDE",
      status: "ok",
      created_at: 1_760_000_000_000,
      payload: { project: "ai-agents", mode: "ask", prompt: "ping" },
      result: { output: "PONG" },
    } as never);
    expect(macOutputView(s).lines).toEqual(["PONG"]);
  });

  test("живые чанки дописываются после сохранённого, а не вместо", () => {
    const v = macOutputView(session({ output: ["строка из БД"] }), ["чанк 1", "чанк 2"]);
    expect(v.lines).toEqual(["строка из БД", "чанк 1", "чанк 2"]);
  });

  test("живые чанки без сохранённого вывода тоже видны", () => {
    const v = macOutputView(session({ status: "running", output: [] }), ["идёт…"]);
    expect(v.lines).toEqual(["идёт…"]);
    expect(v.note).toBeNull();
  });
});

describe("когда строк нет — сказано, почему именно", () => {
  test("не-админу: скрыто, а не «не сохранено»", () => {
    const v = macOutputView(session({ redacted: true, output: [] }));
    expect(v.note).toBe(REDACTED_NOTE);
  });

  test("бегущая сессия: вывод будет позже", () => {
    const v = macOutputView(session({ status: "running", output: [] }));
    expect(v.note).toContain("ещё выполняется");
  });

  test("завершившаяся без вывода: так и написано", () => {
    const v = macOutputView(session({ status: "failed", output: [] }));
    expect(v.note).toBe("Вывод не сохранён.");
  });

  test("сессии нет вовсе — не пустая панель молчком", () => {
    expect(macOutputView(undefined).note).toBe("Сессия не найдена.");
  });

  test("ни одна подпись больше не обещает несуществующее событие", () => {
    const notes = [
      macOutputView(session({ redacted: true })),
      macOutputView(session({ status: "running" })),
      macOutputView(session({ status: "failed" })),
      macOutputView(undefined),
    ].map((v) => v.note ?? "");
    for (const n of notes) expect(n).not.toContain("mac.output");
  });
});

describe("страница действительно через это ходит", () => {
  test("панель зовёт macOutputView, а не читает карту чанков напрямую", () => {
    const panel = SRC.slice(SRC.indexOf("{/* Session Output */}"));
    const upToHistory = panel.slice(0, panel.indexOf("{/* History */}"));
    expect(upToHistory).toContain("macOutputView(");
    // Прежняя форма: `outputLog.get(selectedSession)?.map(...)` как источник.
    expect(upToHistory).not.toMatch(/outputLog\.get\(selectedSession\)\?\.map/);
  });

  test("фраза про ожидание SSE со страницы убрана", () => {
    expect(SRC).not.toContain("Ожидание вывода");
  });

  test("карточки истории выбираются — иначе до вывода не дотянуться", () => {
    const history = SRC.slice(SRC.indexOf("{/* History */}"));
    expect(history).toContain("selectProps(session.id)");
  });

  test("выбор работает не только мышью", () => {
    const helper = SRC.slice(SRC.indexOf("function selectProps("));
    expect(helper).toContain("tabIndex: 0");
    expect(helper).toContain("onKeyDown");
    expect(helper).toContain('role: "button"');
  });
});
