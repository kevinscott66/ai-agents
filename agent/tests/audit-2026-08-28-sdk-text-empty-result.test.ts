/**
 * Аудит 2026-08-28: неуспешный прогон CLI превращался в пустую строку, и
 * дальше о нём не оставалось НИ ОДНОЙ записи.
 *
 * Две половины одной дыры, найденные независимо двумя проходами по коду:
 *
 *  1. `runTextViaAgentSdk` (agent-sdk-runtime.ts) разбирал result-сообщение как
 *     `result = m.result ?? ""`. У подтипов `error_max_turns` и
 *     `error_during_execution` поля `result` нет вовсе — то есть отказ CLI
 *     возвращался вызывающему как обычная пустая строка, неотличимая от
 *     «модель промолчала». Основной путь (`runViaAgentSdk`) это чинил ещё
 *     2026-08-20; вспомогательный — нет, хотя ходит по тому же CLI.
 *
 *  2. `compactor.ts` эту пустую строку скармливал `extractJSON` и делал
 *     `if (!json) return;` МОЛЧА. Две соседние ветки ниже («bad JSON, skip»,
 *     «no ops array, skip») логируют, причём у второй прямо в комментарии
 *     написано, почему молчать нельзя. Итог: при перебоях CLI долговременная
 *     память ВСЕХ 12 ролей переставала пополняться, а в журнале — ни строки.
 *     runCompactor зовут fire-and-forget (handoff.ts, message-handler.ts),
 *     повтора нет: что агент решил запомнить за ход, исчезало навсегда.
 *
 * Побочно чинится обвинение не того виновника: self-diag.ts на пустой ответ
 * писал в задачу «aieng response not parseable as JSON: » — то есть валил на
 * модель сбой запуска CLI. Теперь оттуда приходит исключение, и задача
 * закрывается как «aieng call failed: …».
 *
 * Сам прогон CLI здесь не спавнится (нужен CLAUDE_BIN и сеть), поэтому первая
 * половина проверяется по исходнику, вторая — живым вызовом runCompactor по
 * raw-пути с подставным клиентом.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { runCompactor } from "../lib/compactor.ts";
import type Anthropic from "@anthropic-ai/sdk";

const SRC = readFileSync(new URL("../lib/agent-sdk-runtime.ts", import.meta.url), "utf8");

/** Тело именно вспомогательной функции, а не всего файла. */
function textFnBody(): string {
  const from = SRC.indexOf("export async function runTextViaAgentSdk");
  const to = SRC.indexOf("export function markTruncatedTurn");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to);
}

describe("runTextViaAgentSdk: неуспешный подтип больше не «пустой ответ»", () => {
  test("подтип result-сообщения запоминается", () => {
    expect(textFnBody()).toContain('subtype = String((m as any).subtype ?? "")');
  });

  test("на неуспешном подтипе пишется предупреждение", () => {
    const body = textFnBody();
    expect(body).toMatch(/if \(subtype && subtype !== "success"\) \{/);
    expect(body).toContain("[agent-sdk] non-success text result");
  });

  test("пустой текст уходит исключением, а не пустой строкой", () => {
    const body = textFnBody();
    expect(body).toMatch(/if \(!text\.trim\(\)\) \{\s*throw new Error\(/);
    // Ровно та регрессия, которую чиним: голый `return result;` в хвосте.
    expect(body).not.toMatch(/\n  return result;\n\}/);
  });

  test("текст ассистента подхватывается тем же сборщиком, что и на основном пути", () => {
    // Своя копия разбора content[] разъезжается с основной; проверяем
    // переиспользование exported-хелпера.
    expect(textFnBody()).toContain("assistantText(m)");
  });

  test("markTruncatedTurn тут НЕ зовётся — вызывающие ждут JSON", () => {
    // Приписка «(ход прерван: …)» на основном пути адресована человеку в чате.
    // Здесь ответ парсится как JSON (компактор, self-diag) — та же приписка
    // сломала бы extractJSON.
    expect(textFnBody()).not.toContain("markTruncatedTurn(");
  });

  test("расход по-прежнему пишется при падении (регрессия 2026-08-13)", () => {
    expect(textFnBody()).toMatch(/\} catch \(e\) \{\s*spend\(spentInput, spentOutput\);/);
  });
});

/* ------------------------------------------------------------------ */

const SDK_BEFORE = process.env.USE_AGENT_SDK;

afterEach(() => {
  if (SDK_BEFORE === undefined) delete process.env.USE_AGENT_SDK;
  else process.env.USE_AGENT_SDK = SDK_BEFORE;
});

/** Клиент-заглушка: отдаёт ровно тот текст, который нужен сценарию. */
function fakeClient(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  } as unknown as Anthropic;
}

/** Снять всё, что ушло в журнал за время вызова. */
async function capture(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

const CTX = {
  agentKey: "_test_compactor_silence",
  chatId: "-100777",
  userText: "что решили по деплою?",
  agentReply:
    "Катим в пятницу утром, откат через deploy/rollback.sh, health-gate локальный.",
  recentContext: "",
};

describe("compactor: тихие выходы стали видимыми", () => {
  test("ответ без JSON пишет warn, а не молчит", async () => {
    process.env.USE_AGENT_SDK = "false";
    const out = await capture(() =>
      // Ровно то, что отдавал сломанный SDK-путь: ни скобки, ни ops.
      runCompactor(fakeClient(""), CTX),
    );
    expect(out).toContain("[compactor] no JSON in reply, skip");
    expect(out).toContain(CTX.agentKey);
  });

  test("осмысленный текст без JSON тоже попадает в журнал", async () => {
    process.env.USE_AGENT_SDK = "false";
    const out = await capture(() =>
      runCompactor(fakeClient("Не могу выполнить эту просьбу."), CTX),
    );
    expect(out).toContain("[compactor] no JSON in reply, skip");
  });

  test("невалидная операция внутри ops больше не выпадает молча", async () => {
    process.env.USE_AGENT_SDK = "false";
    const out = await capture(() =>
      runCompactor(fakeClient('{"ops":[{"op":"delete_everything"}]}'), CTX),
    );
    expect(out).toContain("[compactor] bad op, skip");
    // Имя операции в строке — иначе по журналу не понять, что именно отбросили.
    expect(out).toContain("delete_everything");
  });

  test("валидный noop проходит без единого предупреждения", async () => {
    process.env.USE_AGENT_SDK = "false";
    const out = await capture(() =>
      runCompactor(fakeClient('{"ops":[{"op":"noop"}]}'), CTX),
    );
    expect(out).not.toContain("[compactor]");
  });

  test("короткая реплика по-прежнему пропускается без вызова модели", async () => {
    process.env.USE_AGENT_SDK = "false";
    let called = false;
    const client = {
      messages: {
        create: async () => {
          called = true;
          return { content: [], usage: {} };
        },
      },
    } as unknown as Anthropic;
    const out = await capture(() =>
      runCompactor(client, { ...CTX, agentReply: "ок" }),
    );
    expect(called).toBe(false);
    expect(out).not.toContain("[compactor]");
  });
});
