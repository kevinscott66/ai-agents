/**
 * Аудит 2026-08-28: 429 от Telegram принимали за исчерпанную квоту OpenAI.
 *
 * `try` в handleGenerateImage накрывал сразу два разных внешних вызова —
 * платный `generateImage` и отправку `tgSendPhoto`, — а `catch`
 * классифицировал ошибку подстрокой: `isOpenAIQuotaError` срабатывает на
 * `"429"` в тексте. Ошибка telegraf выглядит как `"429: Too Many Requests:
 * retry after 40"` (TelegramError: `super(\`${error_code}: ${description}\`)`),
 * то есть подходит буквально.
 *
 * Что происходило при флуд-контроле чата: картинка у OpenAI УЖЕ куплена, но
 * буфер выбрасывался; тратился второй вызов Claude на generateSvgFromPrompt;
 * результат слался в тот же залимиченный чат (обычно снова мимо); а если
 * доезжал — действие писалось `ok:true` с `fallback_reason: "429: Too Many
 * Requests…"`, то есть провал отправки задокументирован как квота вендора.
 * GENERATE_IMAGE лежит в NO_REFUND_ACTIONS, так что слот бюджета сгорал тоже.
 *
 * Правильная форма — в этом же файле двумя десятками строк выше: у
 * generateCoverPng try обнимает только вызов вендора.
 */
import { describe, expect, test } from "bun:test";
import { handleGenerateImage } from "../lib/dispatch/media.ts";

const PNG = Buffer.from("fake-png");
const RENDERABLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><rect width="1024" height="1024" fill="#123"/></svg>';

/** Ошибка telegraf ровно той формы, что уходит из tgSendPhoto наружу. */
function telegramFlood(): Error {
  return new Error("429: Too Many Requests: retry after 40");
}

const ctx = { telegram: {} as any, agentKey: "design", chatId: -100500 };
const payload = { prompt: "кот на подоконнике", caption: "мяу" } as any;

describe("флуд-контроль Telegram не выдаёт себя за квоту OpenAI", () => {
  test("отказ отправки не запускает SVG-фолбэк", async () => {
    let svgCalls = 0;
    let sends = 0;
    const res = await handleGenerateImage(payload, ctx, {
      generate: async () => PNG,
      fallbackSvg: async () => {
        svgCalls++;
        return "<svg/>";
      },
      send: async () => {
        sends++;
        throw telegramFlood();
      },
    });

    // Второго платного вызова Claude нет.
    expect(svgCalls).toBe(0);
    // И повторной отправки в тот же залимиченный чат тоже нет.
    expect(sends).toBe(1);
    expect(res.ok).toBe(false);
  });

  test("провал отправки не записывается как успех с чужой причиной", async () => {
    // Худший случай: вторая отправка проходит. До правки действие писалось
    // `ok:true` с `fallback_reason` от Telegram — то есть в журнале успех,
    // приписанный квоте вендора, которой не было.
    let sends = 0;
    const res: any = await handleGenerateImage(payload, ctx, {
      generate: async () => PNG,
      fallbackSvg: async () => RENDERABLE_SVG,
      send: async () => {
        sends++;
        if (sends === 1) throw telegramFlood();
        return { message_id: 11 };
      },
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("429");
    expect(sends).toBe(1);
    expect(res.result).toBeUndefined();
  });

  test("любой другой отказ отправки тоже не уводит в фолбэк", async () => {
    let svgCalls = 0;
    const res = await handleGenerateImage(payload, ctx, {
      generate: async () => PNG,
      fallbackSvg: async () => {
        svgCalls++;
        return "<svg/>";
      },
      send: async () => {
        throw new Error("400: Bad Request: chat not found");
      },
    });
    expect(svgCalls).toBe(0);
    expect(res.ok).toBe(false);
  });
});

describe("настоящая квота OpenAI ведёт себя как раньше", () => {
  test("insufficient_quota уводит в SVG-фолбэк и помечает запись", async () => {
    let svgCalls = 0;
    const sent: Buffer[] = [];
    const res: any = await handleGenerateImage(payload, ctx, {
      generate: async () => {
        throw new Error("insufficient_quota: you exceeded your current quota");
      },
      fallbackSvg: async () => {
        svgCalls++;
        return RENDERABLE_SVG;
      },
      send: async (b) => {
        sent.push(b);
        return { message_id: 7 };
      },
    });
    expect(svgCalls).toBe(1);
    expect(sent.length).toBe(1);
    expect(res.ok).toBe(true);
    expect(res.result.fallback_from).toBe("GENERATE_IMAGE");
    expect(String(res.result.fallback_reason)).toContain("insufficient_quota");
  });

  test("429 от самого OpenAI — по-прежнему фолбэк", async () => {
    let svgCalls = 0;
    const res: any = await handleGenerateImage(payload, ctx, {
      generate: async () => {
        throw new Error("429 Too Many Requests from api.openai.com");
      },
      fallbackSvg: async () => {
        svgCalls++;
        return RENDERABLE_SVG;
      },
      send: async () => ({ message_id: 8 }),
    });
    expect(svgCalls).toBe(1);
    expect(res.ok).toBe(true);
  });

  test("отказ отправки уже в фолбэке остаётся честным провалом", async () => {
    const res: any = await handleGenerateImage(payload, ctx, {
      generate: async () => {
        throw new Error("billing_hard_limit_reached");
      },
      fallbackSvg: async () => RENDERABLE_SVG,
      send: async () => {
        throw telegramFlood();
      },
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("svg-fallback also failed");
  });

  test("обычный отказ генерации без квоты в фолбэк не уходит", async () => {
    let svgCalls = 0;
    const res = await handleGenerateImage(payload, ctx, {
      generate: async () => {
        throw new Error("invalid_request_error: prompt rejected");
      },
      fallbackSvg: async () => {
        svgCalls++;
        return "<svg/>";
      },
      send: async () => ({ message_id: 9 }),
    });
    expect(svgCalls).toBe(0);
    expect(res.ok).toBe(false);
  });
});
