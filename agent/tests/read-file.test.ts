/**
 * READ_FILE (P1 2026-06-09): приём текстовых файлов-вложений от пользователя.
 *  - isTextDocument: распознавание по mime / расширению
 *  - tool-loop inputDocuments: содержимое файла подмешивается в последний
 *    user-message отдельным text-блоком перед текстом пользователя.
 */
import { describe, test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";
import { isTextDocument } from "../orchestrator/message-handler.ts";

describe("isTextDocument", () => {
  test("text/* mime → true", () => {
    expect(isTextDocument({ mime_type: "text/plain" })).toBe(true);
    expect(isTextDocument({ mime_type: "text/markdown" })).toBe(true);
    expect(isTextDocument({ mime_type: "text/csv" })).toBe(true);
  });
  test("known application mime → true", () => {
    expect(isTextDocument({ mime_type: "application/json" })).toBe(true);
    expect(isTextDocument({ mime_type: "application/x-yaml" })).toBe(true);
  });
  test("octet-stream но текстовое расширение → true", () => {
    expect(
      isTextDocument({ mime_type: "application/octet-stream", file_name: "audit.md" }),
    ).toBe(true);
    expect(
      isTextDocument({ mime_type: "application/octet-stream", file_name: "data.csv" }),
    ).toBe(true);
  });
  test("картинка / бинарь без текст-расширения → false", () => {
    expect(isTextDocument({ mime_type: "image/png" })).toBe(false);
    expect(
      isTextDocument({ mime_type: "application/octet-stream", file_name: "a.bin" }),
    ).toBe(false);
    expect(isTextDocument({ mime_type: "application/pdf", file_name: "a.pdf" })).toBe(false);
  });
  test("мусор → false", () => {
    expect(isTextDocument(null)).toBe(false);
    expect(isTextDocument(undefined)).toBe(false);
    expect(isTextDocument("nope")).toBe(false);
  });
});

describe("tool-loop: inputDocuments инжект", () => {
  test("содержимое файла попадает в последний user-message text-блоком", async () => {
    let captured: Anthropic.MessageParam[] | null = null;
    const fakeAnthropic = {
      messages: {
        create: async (req: Anthropic.MessageCreateParamsNonStreaming) => {
          captured = [...req.messages];
          return {
            id: "m1",
            type: "message",
            role: "assistant",
            model: "test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: "ок, прочитал файл" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;

    const final = await runWithTools({
      anthropic: fakeAnthropic,
      model: "test",
      system: [{ type: "text", text: "test agent" }],
      messages: [{ role: "user", content: "разбери этот файл" }],
      agentKey: "qa",
      chatId: -1000,
      allowedTools: [],
      inputDocuments: [
        { filename: "report.md", text: "# Заголовок\nстрока данных" },
      ],
    });

    expect(final).toContain("прочитал");
    expect(captured).not.toBeNull();
    const last = captured![captured!.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Anthropic.ContentBlockParam[];
    // Должен быть text-блок с обёрткой файла + исходный текст пользователя.
    const joined = blocks
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(joined).toContain("report.md");
    expect(joined).toContain("# Заголовок");
    expect(joined).toContain("строка данных");
    expect(joined).toContain("разбери этот файл");
  });

  test("пустой inputDocuments не ломает обычный путь (content остаётся строкой)", async () => {
    let captured: Anthropic.MessageParam[] | null = null;
    const fakeAnthropic = {
      messages: {
        create: async (req: Anthropic.MessageCreateParamsNonStreaming) => {
          captured = [...req.messages];
          return {
            id: "m1",
            type: "message",
            role: "assistant",
            model: "test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "text", text: "ответ" }],
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;

    await runWithTools({
      anthropic: fakeAnthropic,
      model: "test",
      system: [{ type: "text", text: "test agent" }],
      messages: [{ role: "user", content: "просто текст" }],
      agentKey: "qa",
      chatId: -1000,
      allowedTools: [],
    });
    const last = captured![captured!.length - 1];
    expect(typeof last.content).toBe("string");
  });
});
