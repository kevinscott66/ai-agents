/**
 * C9: OpenAI gpt-image-1 → PNG buffer.
 *
 * Используется action'ом GENERATE_IMAGE: агент пишет английский промпт,
 * бэкенд зовёт OpenAI REST API напрямую через fetch (без SDK), получает
 * base64-PNG и отдаёт Buffer.
 *
 * Ограничения:
 *  - prompt length ≤ 4000 chars;
 *  - OPENAI_API_KEY должен быть в env на момент вызова (читаем лениво,
 *    чтобы тесты без ключа не падали при импорте модуля).
 *  - gpt-image-1 всегда возвращает base64; параметр response_format не
 *    поддерживается (он для старых dall-e моделей и даёт 400).
 */

import { vendorErrorDetail } from "./errors.ts";

export interface GenerateImageOpts {
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
}

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

/**
 * T-305 MED-4: strip PII (emails, phone numbers) from the prompt before it
 * leaves the box to OpenAI. The LLM-authored prompt may have quoted user
 * text verbatim ("generate avatar for John, +1-555-…"). OpenAI does not need
 * personal identifiers to render an image, and we do not want them in
 * vendor-side request logs.
 */
export function redactPromptForVendor(prompt: string): string {
  if (process.env.OPENAI_PROMPT_REDACT === "0") return prompt;
  return prompt
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email-redacted>")
    .replace(/\+\d[\d\s\-()]{8,}\d/g, "<phone-redacted>");
}

interface OpenAIImageResponse {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

export async function generateImage(
  prompt: string,
  opts: GenerateImageOpts = {},
): Promise<Buffer> {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt is empty");
  }
  if (prompt.length > 4000) {
    throw new Error("prompt too long (>4000 chars)");
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  // T-305 MED-4: PII redaction at the egress boundary.
  const safePrompt = redactPromptForVendor(prompt);
  const body: Record<string, unknown> = {
    model: "gpt-image-1",
    prompt: safePrompt,
    n: 1,
  };
  if (opts.size) body.size = opts.size;
  if (opts.quality) body.quality = opts.quality;
  if (opts.background) body.background = opts.background;

  const res = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // SEC-audit: bound the request. Image gen is slow → generous 60s timeout.
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await vendorErrorDetail(res);
    throw new Error(
      `OpenAI image API error ${res.status}${detail ? ": " + detail : ""}`,
    );
  }

  const json = (await res.json()) as OpenAIImageResponse;
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI image API: missing data[0].b64_json");
  }
  return Buffer.from(b64, "base64");
}
