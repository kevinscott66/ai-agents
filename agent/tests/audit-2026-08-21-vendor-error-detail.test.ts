/**
 * Аудит 2026-08-21: у openai-image.ts и openai-whisper.ts запасная ветка чтения
 * тела ошибки была мёртвой, и оператор получал голый код статуса.
 *
 * Было в обоих файлах одно и то же:
 *
 *   let detail = "";
 *   try {
 *     const j = await res.json();
 *     detail = j?.error?.message ?? "";
 *   } catch {
 *     try { detail = await res.text(); } catch {}
 *   }
 *
 * Замер на 18KB HTML-странице шлюза (502): `res.json()` бросает «Failed to
 * parse JSON», но тело к этому моменту уже ПОТРАЧЕНО (`res.bodyUsed === true`),
 * поэтому `res.text()` бросает «Body already used», внешний catch глотает, и
 * detail остаётся пустым. Сообщение выходило 26 байт — «OpenAI image API error
 * 502», ровно в том случае, когда пояснение и нужно: по одному коду статуса не
 * отличить «отказал вендор» от «отказал прокси перед вендором».
 *
 * Стало: тело читается ОДИН раз текстом (vendorErrorDetail в lib/errors.ts —
 * файл ровно про консолидацию таких идиом, T-610), JSON разбирается уже из
 * строки. Хвост режется до MAX_VENDOR_DETAIL: не-JSON телом бывает целая
 * HTML-страница, а строка уезжает и в `agent_actions.error` (там обрезки нет),
 * и в контекст модели.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { vendorErrorDetail, MAX_VENDOR_DETAIL } from "../lib/errors.ts";
import { generateImage } from "../lib/openai-image.ts";
import { transcribeVoice } from "../lib/openai-whisper.ts";
import { readFileSync } from "node:fs";

const IMAGE_SRC = readFileSync(
  new URL("../lib/openai-image.ts", import.meta.url),
  "utf8",
);
const WHISPER_SRC = readFileSync(
  new URL("../lib/openai-whisper.ts", import.meta.url),
  "utf8",
);

/** Убрать комментарии, чтобы сканер не спотыкался о шапку, где процитирован
 *  старый код. Тот же приём уже понадобился в аудитах компактора и SDK. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre) => pre);
}

const HTML_GATEWAY =
  "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>" +
  "<h1>502 Bad Gateway</h1>\n<p>cf-ray: 8f0abc</p>\n".repeat(400) +
  "</body></html>";

describe("vendorErrorDetail", () => {
  test("JSON-тело вендора — отдаём error.message", async () => {
    const res = new Response(
      JSON.stringify({ error: { message: "You exceeded your current quota" } }),
      { status: 429 },
    );
    expect(await vendorErrorDetail(res)).toBe("You exceeded your current quota");
  });

  test("регрессия: не-JSON тело больше НЕ теряется", async () => {
    const res = new Response(HTML_GATEWAY, { status: 502 });
    const detail = await vendorErrorDetail(res);
    // Главное утверждение аудита: раньше здесь была пустая строка.
    expect(detail).not.toBe("");
    expect(detail.length).toBeGreaterThan(0);
    expect(detail).toContain("502 Bad Gateway");
  });

  test("длинное тело режется по MAX_VENDOR_DETAIL с многоточием", async () => {
    const res = new Response(HTML_GATEWAY, { status: 502 });
    const detail = await vendorErrorDetail(res);
    expect(detail.length).toBeLessThanOrEqual(MAX_VENDOR_DETAIL);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("короткое тело не получает метки обрезки", async () => {
    const res = new Response("upstream connect error", { status: 503 });
    const detail = await vendorErrorDetail(res);
    expect(detail).toBe("upstream connect error");
    expect(detail).not.toContain("…");
  });

  test("предел настраивается вторым аргументом", async () => {
    const res = new Response("a".repeat(200), { status: 500 });
    const detail = await vendorErrorDetail(res, 20);
    expect(detail.length).toBe(20);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("переводы строк схлопываются — одна ошибка остаётся одной строкой", async () => {
    const res = new Response("upstream\n\n  connect\terror\n", { status: 503 });
    expect(await vendorErrorDetail(res)).toBe("upstream connect error");
  });

  test("секрет из тела вычищается скруббером", async () => {
    const res = new Response(
      "request to https://api.telegram.org/bot7123456789:AAFvSomeVeryLongLookingSecretToken0123 failed",
      { status: 500 },
    );
    const detail = await vendorErrorDetail(res);
    expect(detail).toContain("7123456789:***");
    expect(detail).not.toContain("AAFvSomeVeryLongLookingSecretToken0123");
  });

  test("вендор ответил структурно, но пояснения нет — сырое тело НЕ подставляем", async () => {
    // Инвариант тот же; фикстура была `{error:{code:"x"}}`, но с аудита
    // 2026-08-28 `code` считается пояснением (см.
    // audit-2026-08-28-vendor-error-shapes.test.ts). Здесь остаётся форма, из
    // которой доставать действительно нечего.
    const res = new Response(JSON.stringify({ error: {} }), {
      status: 400,
    });
    expect(await vendorErrorDetail(res)).toBe("");
  });

  test("JSON незнакомой формы — отдаём тело как есть", async () => {
    // Было `{detail:"nope"}`; с аудита 2026-08-28 `detail` — известный носитель
    // пояснения, и случай переехал в audit-2026-08-28-vendor-error-shapes.
    const res = new Response(JSON.stringify({ nope: "nope" }), { status: 400 });
    expect(await vendorErrorDetail(res)).toBe('{"nope":"nope"}');
  });

  test("тело не читается — пустая строка, а не бросок", async () => {
    const res = new Response("что угодно", { status: 500 });
    await res.text(); // тело потрачено до нас
    expect(await vendorErrorDetail(res)).toBe("");
  });

  test("пустое тело — пустая строка", async () => {
    expect(await vendorErrorDetail(new Response("", { status: 500 }))).toBe("");
  });

  test("тело читается РОВНО один раз", async () => {
    // Перенесено из ветки fix/openai-error-detail (PR #498, закрыт как дубль).
    // Ниже по файлу мёртвая ветка стережётся по тексту исходника; здесь — по
    // поведению, а это разные сторожа: вернуть `res.json()` с запасным
    // `res.text()` можно и не написав ни одной строки, которую ищет grep
    // (другой порядок, другое имя переменной, тернарник). Счётчик ловит любую
    // форму: второй вызов .text() на израсходованном теле — это и есть
    // «Body already used», из-за которого пояснение терялось.
    //
    // Аудит 2026-08-27: чтение переехало с `res.text()` на потоковое с
    // потолком в 64 КБ (readVendorBodyCapped) — тело больше не буферизуется
    // целиком до обрезки. Сторож остался тот же, только считает не вызовы
    // `.text()`, а ЛЮБОЙ захват тела: и `.text()`, и `getReader()`. Второй
    // захват израсходованного тела и есть «Body already used».
    let grabs = 0;
    const res = new Response("<html>502 от шлюза</html>", { status: 502 });
    const origText = res.text.bind(res);
    (res as unknown as { text: () => Promise<string> }).text = () => {
      grabs++;
      return origText();
    };
    const body = res.body!;
    const origGet = body.getReader.bind(body);
    (
      body as unknown as {
        getReader: () => ReadableStreamDefaultReader<Uint8Array>;
      }
    ).getReader = () => {
      grabs++;
      return origGet() as ReadableStreamDefaultReader<Uint8Array>;
    };
    expect(await vendorErrorDetail(res)).toBe("<html>502 от шлюза</html>");
    expect(grabs).toBe(1);
  });
});

// --- сквозная проверка обоих клиентов -------------------------------------

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
});

/** Ни одного сетевого запроса: fetch подменён целиком. */
function stubFetch(body: string, status: number) {
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  globalThis.fetch = (async () =>
    new Response(body, { status })) as unknown as typeof globalThis.fetch;
}

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("ожидали бросок, его не было");
}

describe("клиенты OpenAI: тело ошибки доезжает до оператора", () => {
  test("image: HTML-страница шлюза попадает в текст ошибки", async () => {
    stubFetch(HTML_GATEWAY, 502);
    const msg = await messageOf(() => generateImage("кот"));
    expect(msg).toStartWith("OpenAI image API error 502: ");
    expect(msg).toContain("502 Bad Gateway");
    // Раньше здесь было ровно 26 байт — голый статус без двоеточия.
    expect(msg.length).toBeGreaterThan(100);
  });

  test("image: JSON-ветка не сломана", async () => {
    stubFetch(JSON.stringify({ error: { message: "quota" } }), 429);
    expect(await messageOf(() => generateImage("кот"))).toBe(
      "OpenAI image API error 429: quota",
    );
  });

  test("image: пустое тело не даёт висячего двоеточия", async () => {
    stubFetch("", 500);
    expect(await messageOf(() => generateImage("кот"))).toBe(
      "OpenAI image API error 500",
    );
  });

  test("whisper: HTML-страница шлюза попадает в текст ошибки", async () => {
    stubFetch(HTML_GATEWAY, 502);
    const msg = await messageOf(() =>
      transcribeVoice(Buffer.from("ogg-bytes")),
    );
    expect(msg).toStartWith("OpenAI Whisper API error 502: ");
    expect(msg).toContain("502 Bad Gateway");
    expect(msg.length).toBeGreaterThan(100);
  });

  test("whisper: JSON-ветка не сломана", async () => {
    stubFetch(JSON.stringify({ error: { message: "quota" } }), 429);
    expect(await messageOf(() => transcribeVoice(Buffer.from("ogg")))).toBe(
      "OpenAI Whisper API error 429: quota",
    );
  });
});

describe("исходники: мёртвая ветка не вернулась", () => {
  for (const [name, src] of [
    ["openai-image.ts", IMAGE_SRC],
    ["openai-whisper.ts", WHISPER_SRC],
  ] as const) {
    test(`${name} читает тело через vendorErrorDetail`, () => {
      const code = stripComments(src);
      expect(code).toContain("vendorErrorDetail(res)");
      // Позитивный контроль: stripComments не съел файл целиком.
      expect(code).toContain("if (!res.ok)");
    });

    test(`${name} не пробует res.text() после res.json()`, () => {
      const code = stripComments(src);
      expect(code).not.toContain("await res.text()");
    });
  }
});
