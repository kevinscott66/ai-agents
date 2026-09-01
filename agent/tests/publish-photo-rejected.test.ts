/**
 * Аудит 2026-08-11, продолжение publish-cover-degrade: обложку мы теперь
 * получаем под try/catch, но ОТПРАВКА фото по-прежнему может убить пост.
 *
 * `photoUrl` уходит в Telegram как ссылка, и картинку по ней качает сам
 * Telegram. Ссылка не на картинку (агент взял её из web_search), редирект на
 * HTML, слишком большой файл, битые размеры — всё это 400 вида «failed to get
 * HTTP URL content». То же с `photoBase64`, если агент прислал мусор:
 * «IMAGE_PROCESS_FAILED». Такой 400 приходит ДО доставки: в канале не
 * появилось ничего. А пост при этом терялся целиком — вместе с потраченным
 * апрувом.
 *
 * Разница с сетевой ошибкой принципиальна и поэтому проверяется отдельно.
 * 400 про фото — детерминированный отказ, повтор текстом безопасен. Таймаут
 * или 429 означают «ответ потерян», а не «не доставлено»: запрос мог дойти, и
 * повтор текстом дал бы в канале второй экземпляр поста. Прецедент —
 * sendWithHtml, где безразборный catch дублировал сообщения (аудит 2026-08-04).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { isPhotoRejected } from "../lib/telegram-actions.ts";
import { db } from "../lib/db.ts";

const CH = -100779;

type Sent = { kind: "message" | "photo"; chatId: number; text?: string };

/** telegraf кладёт ответ Bot API в `e.response`. */
const tgError = (code: number, description: string) =>
  Object.assign(new Error(`${code}: ${description}`), {
    response: { error_code: code, description },
  });

const fakeTg = (photoFails?: Error) => {
  const sent: Sent[] = [];
  return {
    sent,
    tg: {
      sendMessage: (chatId: number, text: string) => {
        sent.push({ kind: "message", chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      sendPhoto: (chatId: number, _photo: unknown, extra: { caption?: string }) => {
        if (photoFails) return Promise.reject(photoFails);
        sent.push({ kind: "photo", chatId, text: extra?.caption });
        return Promise.resolve({ message_id: 2 });
      },
    } as any,
  };
};

const publish = async (payload: Record<string, unknown>, f: ReturnType<typeof fakeTg>) =>
  await dispatchAction(
    "PUBLISH_TO_CHANNEL",
    { channelId: CH, ...payload } as any,
    { agentKey: "smm", chatId: -1, telegram: f.tg } as any,
  );

describe("isPhotoRejected: только детерминированный отказ по картинке", () => {
  test("400 про URL/картинку — да", () => {
    expect(isPhotoRejected(tgError(400, "Bad Request: failed to get HTTP URL content"))).toBe(true);
    expect(isPhotoRejected(tgError(400, "Bad Request: wrong file identifier/HTTP URL specified"))).toBe(true);
    expect(isPhotoRejected(tgError(400, "Bad Request: wrong type of the web page content"))).toBe(true);
    expect(isPhotoRejected(tgError(400, "Bad Request: IMAGE_PROCESS_FAILED"))).toBe(true);
    expect(isPhotoRejected(tgError(400, "Bad Request: PHOTO_INVALID_DIMENSIONS"))).toBe(true);
  });

  test("сеть, 429 и 5xx — нет", () => {
    expect(isPhotoRejected(new Error("fetch failed: ETIMEDOUT"))).toBe(false);
    expect(isPhotoRejected(tgError(429, "Too Many Requests: retry after 30"))).toBe(false);
    expect(isPhotoRejected(tgError(500, "Internal Server Error"))).toBe(false);
    // 400, но не про картинку: чат недоступен — текстом тоже не уйдёт.
    expect(isPhotoRejected(tgError(400, "Bad Request: chat not found"))).toBe(false);
  });
});

describe("PUBLISH_TO_CHANNEL: Telegram отверг картинку", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
    registerTeamChannel(CH, "Team Ch", -1);
  });

  test("битый photoUrl → пост уходит текстом", async () => {
    const f = fakeTg(tgError(400, "Bad Request: failed to get HTTP URL content"));
    const out = await publish(
      { text: "**Крючок.** Пост со ссылкой на картинку.", photoUrl: "https://example.com/page.html" },
      f,
    );
    expect(out.ok).toBe(true);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0].kind).toBe("message");
    expect(f.sent[0].text ?? "").toContain("со ссылкой на картинку");
  });

  test("битый photoBase64 → пост уходит текстом", async () => {
    const f = fakeTg(tgError(400, "Bad Request: IMAGE_PROCESS_FAILED"));
    const out = await publish(
      { text: "**Крючок.** Пост с картинкой в base64.", photoBase64: Buffer.from("не png").toString("base64") },
      f,
    );
    expect(out.ok).toBe(true);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0].kind).toBe("message");
  });

  test("длинный пост: фото отвергнуто → текст уходит одним сообщением", async () => {
    // Ветка «фото + отдельное сообщение» (текст длиннее лимита подписи):
    // фото там уходит первым, значит его отказ тоже означает «в канале пусто».
    const f = fakeTg(tgError(400, "Bad Request: failed to get HTTP URL content"));
    const out = await publish(
      {
        text: `**Крючок.** ${"Длинный пост про аирдропы. ".repeat(60)}`,
        photoUrl: "https://example.com/page.html",
      },
      f,
    );
    expect(out.ok).toBe(true);
    expect(f.sent.filter((s) => s.kind === "message").length).toBe(1);
  });

  test("сетевая ошибка на фото → пост НЕ переотправляется текстом", async () => {
    // Ответ потерян ≠ не доставлено. Дубль в канале хуже честной ошибки.
    const f = fakeTg(new Error("fetch failed: ETIMEDOUT"));
    const out = await publish(
      { text: "**Крючок.** Пост.", photoUrl: "https://example.com/pic.png" },
      f,
    );
    expect(out.ok).toBe(false);
    expect(f.sent.length).toBe(0);
  });
});
