/**
 * Аудит 2026-08-07: обложка публикации не проверялась ничем.
 *
 * photoUrl уходил в Bot API любой строкой; photoBase64 — прямиком в
 * Buffer.from(x, "base64"), который молча выбрасывает недопустимые символы:
 * из `data:image/png;base64,...` получался обрезанный мусор, а из совсем
 * кривой строки — пустой буфер, уходивший в Telegram как «фото». Ловилось это
 * только 400-й от Telegram — то есть уже ПОСЛЕ того, как человек одобрил
 * публикацию: апрув потрачен, пост не вышел.
 *
 * Проверка живёт в build-payload, до создания карточки апрува.
 */
import { describe, test, expect } from "bun:test";
import {
  buildPayload,
  validatePhotoUrl,
  normalizePhotoBase64,
  MAX_PHOTO_BYTES,
} from "../lib/dispatch/build-payload.ts";

const ctx = { agentKey: "smm", chatId: -1 } as never;
const build = (input: Record<string, unknown>) =>
  buildPayload("PUBLISH_TO_CHANNEL", input, ctx);

describe("photoUrl: только http/https", () => {
  test("http и https проходят", () => {
    expect(validatePhotoUrl("https://delabs.space/a.png")).toBeNull();
    expect(validatePhotoUrl("http://delabs.space/a.png")).toBeNull();
  });

  test("file:/data:/ftp: отклоняются с внятной причиной", () => {
    for (const u of ["file:///etc/passwd", "data:image/png;base64,AAAA", "ftp://x/y.png"]) {
      expect(validatePhotoUrl(u)).toContain("http/https");
    }
  });

  test("не-URL отклоняется", () => {
    expect(validatePhotoUrl("cover.png")).toContain("не URL");
  });

  test("payload с битым photoUrl не собирается — апрув не тратится", () => {
    const r = build({ channelId: -100777, text: "пост", photoUrl: "file:///etc/passwd" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("photoUrl");
  });
});

describe("photoBase64: нормализация и лимиты", () => {
  const png = Buffer.from("hello world, pretend this is a png").toString("base64");

  test("чистый base64 проходит как есть", () => {
    const r = normalizePhotoBase64(png);
    expect(r).toEqual({ value: png });
  });

  test("data:-префикс снимается, а не режется в мусор", () => {
    const r = normalizePhotoBase64(`data:image/png;base64,${png}`);
    expect(r).toEqual({ value: png });
    // Ключевое: раньше префикс уезжал в Buffer.from и портил картинку.
    expect(Buffer.from((r as { value: string }).value, "base64").toString()).toContain("pretend");
  });

  test("переносы строк не ломают вход", () => {
    const wrapped = png.match(/.{1,8}/g)!.join("\n");
    expect(normalizePhotoBase64(wrapped)).toEqual({ value: png });
  });

  test("мусор отклоняется, а не превращается в пустой буфер", () => {
    const r = normalizePhotoBase64("это точно не base64!!! ???");
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("не base64");
  });

  test("пустая строка отклоняется", () => {
    expect("error" in normalizePhotoBase64("   ")).toBe(true);
  });

  test("картинка больше 10 МБ отклоняется", () => {
    const huge = "A".repeat(Math.ceil((MAX_PHOTO_BYTES + 1_000_000) * 4 / 3));
    const r = normalizePhotoBase64(huge);
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("10 МБ");
  });

  test("payload с мусорным photoBase64 не собирается", () => {
    const r = build({ channelId: -100777, text: "пост", photoBase64: "не base64 ???" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("photoBase64");
  });

  test("валидный payload собирается, префикс уже снят", () => {
    const r = build({
      channelId: -100777,
      text: "пост",
      photoBase64: `data:image/png;base64,${png}`,
    });
    expect(r.ok).toBe(true);
    expect((r as { payload: { photoBase64: string } }).payload.photoBase64).toBe(png);
  });
});
