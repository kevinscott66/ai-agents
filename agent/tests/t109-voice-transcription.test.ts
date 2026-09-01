/**
 * T-109: Voice message transcription tests
 * 
 * Tests OpenAI Whisper integration and voice message handling
 */

import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { transcribeVoice } from "../lib/openai-whisper.ts";

// Mock fetch globally
const mockFetch = spyOn(globalThis, "fetch");

/**
 * У fetch второй аргумент опционален, а headers объявлены как HeadersInit
 * (в том числе массив пар). transcribeVoice всегда передаёт init с объектом
 * заголовков — сужаем до того, что тест реально читает.
 */
type WhisperInit = RequestInit & { headers: Record<string, string> };
const fetchCall = (i: number): [string, WhisperInit] =>
  mockFetch.mock.calls[i] as unknown as [string, WhisperInit];

describe("T-109 Voice Transcription", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OPENAI_API_KEY = "test-key-123";
  });

  // Restore the real global fetch so later test files (HTTP/miniapp endpoints)
  // are not poisoned by this module-level spy.
  afterAll(() => {
    mockFetch.mockRestore();
  });

  describe("transcribeVoice", () => {
    test("should transcribe audio successfully", async () => {
      // Mock successful response
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        text: "Hello, this is a test voice message."
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

      const audioBuffer = Buffer.from("fake audio data");
      const result = await transcribeVoice(audioBuffer, "test.ogg");

      expect(result).toBe("Hello, this is a test voice message.");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      const [url, options] = fetchCall(0);
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe("Bearer test-key-123");
      expect(options.body).toBeInstanceOf(FormData);
    });

    test("should handle API errors", async () => {
      // Mock error response
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Invalid audio format" }
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }));

      const audioBuffer = Buffer.from("fake audio data");
      
      await expect(transcribeVoice(audioBuffer)).rejects.toThrow(
        "OpenAI Whisper API error 400: Invalid audio format"
      );
    });

    test("should reject empty audio buffer", async () => {
      const audioBuffer = Buffer.from("");
      
      await expect(transcribeVoice(audioBuffer)).rejects.toThrow(
        "Audio buffer is empty"
      );
    });

    test("should reject when API key missing", async () => {
      delete process.env.OPENAI_API_KEY;
      
      const audioBuffer = Buffer.from("fake audio data");
      
      await expect(transcribeVoice(audioBuffer)).rejects.toThrow(
        "OPENAI_API_KEY is not set"
      );
    });

    test("should handle missing text in response", async () => {
      // Mock response without text field
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        // Missing text field
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

      const audioBuffer = Buffer.from("fake audio data");
      
      await expect(transcribeVoice(audioBuffer)).rejects.toThrow(
        "OpenAI Whisper API: missing text in response"
      );
    });

    test("should pass language parameter when provided", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        text: "Привет мир"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

      const audioBuffer = Buffer.from("fake audio data");
      await transcribeVoice(audioBuffer, "test.ogg", { language: "ru" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = fetchCall(0);
      
      // Check that FormData includes language
      const formData = options.body as FormData;
      expect(formData.get("language")).toBe("ru");
      expect(formData.get("model")).toBe("whisper-1");
    });

    test("should trim whitespace from transcribed text", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        text: "  Hello world  \n  "
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

      const audioBuffer = Buffer.from("fake audio data");
      const result = await transcribeVoice(audioBuffer);

      expect(result).toBe("Hello world");
    });
  });
});