/**
 * T-514: unit tests for svg-fallback helpers (no network calls).
 *
 * Полный e2e цикл GENERATE_IMAGE→fallback требует mock'ов tgSendPhoto +
 * renderSvgToPng + callAnthropic — оставлен на интеграционный смоук в проде.
 * Здесь покрываем только чистые helpers.
 */
import { describe, expect, it } from "bun:test";
import { isOpenAIQuotaError, extractSvg } from "../lib/svg-fallback.ts";

describe("svg-fallback / isOpenAIQuotaError", () => {
  it("detects 429 in OpenAI image error wrapper", () => {
    const e = new Error("OpenAI image API error 429: rate limit exceeded");
    expect(isOpenAIQuotaError(e)).toBe(true);
  });

  it("does not mistake a Telegram flood-control error for OpenAI quota", () => {
    expect(
      isOpenAIQuotaError(new Error("429: Too Many Requests: retry after 40")),
    ).toBe(false);
  });

  it("does NOT mistake a Telegram 429 for an OpenAI quota error", () => {
    const e = new Error("Telegram API error 429: Too Many Requests");
    expect(isOpenAIQuotaError(e)).toBe(false);
  });

  it("detects insufficient_quota", () => {
    const e = new Error(
      "OpenAI image API error 400: insufficient_quota — please add billing",
    );
    expect(isOpenAIQuotaError(e)).toBe(true);
  });

  it("detects billing_hard_limit_reached", () => {
    const e = new Error(
      "OpenAI image API error 400: billing_hard_limit_reached",
    );
    expect(isOpenAIQuotaError(e)).toBe(true);
  });

  it("detects billing_not_active", () => {
    const e = new Error("billing_not_active for project xyz");
    expect(isOpenAIQuotaError(e)).toBe(true);
  });

  it("does NOT fallback on transient 5xx", () => {
    const e = new Error("OpenAI image API error 503: service unavailable");
    expect(isOpenAIQuotaError(e)).toBe(false);
  });

  it("does NOT fallback on prompt validation errors", () => {
    expect(isOpenAIQuotaError(new Error("prompt is empty"))).toBe(false);
    expect(isOpenAIQuotaError(new Error("prompt too long (>4000 chars)"))).toBe(
      false,
    );
  });

  it("handles non-Error throwables", () => {
    expect(isOpenAIQuotaError("insufficient_quota raw string")).toBe(true);
    expect(isOpenAIQuotaError(null)).toBe(false);
    expect(isOpenAIQuotaError(undefined)).toBe(false);
  });
});

describe("svg-fallback / extractSvg", () => {
  it("extracts inline svg as-is", () => {
    const txt = `<svg viewBox="0 0 10 10"><rect/></svg>`;
    expect(extractSvg(txt)).toBe(txt);
  });

  it("strips markdown fences", () => {
    const txt = '```svg\n<svg viewBox="0 0 10 10"><rect/></svg>\n```';
    expect(extractSvg(txt)).toBe(`<svg viewBox="0 0 10 10"><rect/></svg>`);
  });

  it("strips xml fences", () => {
    const txt = '```xml\n<svg><circle/></svg>\n```';
    expect(extractSvg(txt)).toBe(`<svg><circle/></svg>`);
  });

  it("returns null when no <svg> tag", () => {
    expect(extractSvg("just plain text, no svg here")).toBe(null);
  });

  it("returns null when no </svg> closing tag", () => {
    expect(extractSvg("<svg viewBox='0 0 10 10'><rect/>")).toBe(null);
  });

  it("handles leading commentary by trimming to first <svg>", () => {
    const txt = `Here you go:\n<svg><circle/></svg>`;
    expect(extractSvg(txt)).toBe(`<svg><circle/></svg>`);
  });

  it("handles empty input", () => {
    expect(extractSvg("")).toBe(null);
  });
});
