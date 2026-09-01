/**
 * OpenAI Whisper API integration for voice message transcription.
 * 
 * Converts Telegram voice messages to text using OpenAI's audio transcription
 * endpoint. Follows the same pattern as openai-image.ts.
 */

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Потолок на запрос к Whisper.
 *
 * Аудит 2026-08-12: у этого fetch не было ни таймаута, ни сигнала — при том
 * что соседний openai-image.ts ограничен с самого начала («SEC-audit: bound
 * the request»). Здесь ограничения не появилось, хотя вызов стоит в цепочке,
 * которая уже показала пользователю «печатает…»: зависший сокет к
 * api.openai.com означает, что промис хендлера не завершится никогда — ни
 * ответа, ни строки в лог, ни ветки catch с извинением. Внешне это ровно то
 * же самое, что и сломанный токен, из-за которого голосовые молчали
 * (tests/voice-handler-token.test.ts), — и чинилось бы так же долго.
 *
 * 60 секунд: расшифровка минутного ogg у Whisper занимает единицы секунд,
 * запас — на холодный старт и ретраи на стороне OpenAI. Столько же стоит у
 * генерации картинки, которая заведомо медленнее.
 */
export const OPENAI_WHISPER_TIMEOUT_MS = 60_000;

import { vendorErrorDetail } from "./errors.ts";

export interface TranscribeVoiceOpts {
  language?: string; // ISO-639-1 language code, optional
}

interface OpenAITranscriptionResponse {
  text?: string;
  error?: { message?: string; type?: string; code?: string };
}

export async function transcribeVoice(
  audioBuffer: Buffer,
  filename: string = "voice.ogg",
  opts: TranscribeVoiceOpts = {}
): Promise<string> {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error("Audio buffer is empty");
  }
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  // Create form data for multipart upload
  const formData = new FormData();
  // Вьюха без копирования: Buffer типизирован как ArrayBufferLike, а BlobPart
  // требует именно ArrayBuffer. Переносим смещение и длину, чтобы не отправить
  // чужой хвост пула, из которого Node выдаёт Buffer.
  const audioBytes = new Uint8Array(
    audioBuffer.buffer as ArrayBuffer,
    audioBuffer.byteOffset,
    audioBuffer.byteLength,
  );
  const audioBlob = new Blob([audioBytes], { type: "audio/ogg" });
  formData.append("file", audioBlob, filename);
  formData.append("model", "whisper-1");
  
  if (opts.language) {
    formData.append("language", opts.language);
  }

  const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(OPENAI_WHISPER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await vendorErrorDetail(res);
    throw new Error(
      `OpenAI Whisper API error ${res.status}${detail ? ": " + detail : ""}`
    );
  }

  const json = (await res.json()) as OpenAITranscriptionResponse;
  const text = json?.text;
  if (!text) {
    throw new Error("OpenAI Whisper API: missing text in response");
  }
  
  return text.trim();
}