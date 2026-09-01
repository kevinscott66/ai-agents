/**
 * SDK-путь помечает отказ инструмента как ошибку (аудит 2026-08-04).
 *
 * MCP-обёртка ставила `isError` только когда `executeTool` БРОСИЛ. Но он почти
 * никогда не бросает: отказ гейта, рейт-лимита, валидатора payload'а или
 * хендлера возвращается строкой `{"ok":false,...}`. На проде USE_AGENT_SDK=true
 * — значит отбитый SEND_MESSAGE приходил модели обычным успешным результатом,
 * и она честно рапортовала пользователю «отправил». Raw-путь ту же строку
 * разбирает и ставит `is_error: true` (tool-loop.ts).
 *
 * Тут проверяются оба конца: классификация и то, что обёртка ею пользуется.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { isFailureResult } from "../lib/agent-sdk-runtime.ts";
import { executeTool } from "../lib/tools-schema.ts";

const SRC = readFileSync(
  new URL("../lib/agent-sdk-runtime.ts", import.meta.url),
  "utf8",
);

describe("классификация результата инструмента", () => {
  test("ok:false — отказ", () => {
    expect(isFailureResult(JSON.stringify({ ok: false, error: "denied" }))).toBe(
      true,
    );
  });

  test("ok:true — успех", () => {
    expect(isFailureResult(JSON.stringify({ ok: true, taskId: "x" }))).toBe(
      false,
    );
  });

  test("не-JSON — успех", () => {
    // READ_WIKI и подобные отдают сырой текст; трактовать его как ошибку
    // означало бы ломать работающие инструменты ради несуществующей проблемы.
    expect(isFailureResult("# Заметка\nтекст")).toBe(false);
    expect(isFailureResult("")).toBe(false);
  });

  test("JSON без ok — успех", () => {
    expect(isFailureResult(JSON.stringify({ rows: [1, 2] }))).toBe(false);
    expect(isFailureResult("null")).toBe(false);
  });

  test("настоящий отказ executeTool распознаётся", async () => {
    // Не синтетика: это ровно та строка, которую обёртка получает в проде.
    const out = await executeTool(
      "NO_SUCH_TOOL",
      {},
      { agentKey: "orchestrator", chatId: -1 } as never,
    );
    expect(JSON.parse(out).ok).toBe(false);
    expect(isFailureResult(out)).toBe(true);
  });
});

describe("обёртка MCP пользуется классификацией", () => {
  function toolWrapperBody(): string {
    const start = SRC.indexOf("const out = await executeTool(");
    expect(start).toBeGreaterThan(-1);
    return SRC.slice(start, SRC.indexOf("} catch (e) {", start));
  }

  test("успешная ветка ставит isError на ok:false", () => {
    const body = toolWrapperBody();
    expect(body).toMatch(/isFailureResult\(out\)/);
    expect(body).toMatch(/isError: true/);
  });

  test("исключение по-прежнему помечается ошибкой", () => {
    // Прежнее поведение не потеряно: catch остаётся вторым источником isError.
    const tail = SRC.slice(SRC.indexOf("const out = await executeTool("));
    const cat = tail.slice(tail.indexOf("} catch (e) {"));
    expect(cat.slice(0, 400)).toMatch(/isError: true/);
  });
});
