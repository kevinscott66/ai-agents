/**
 * Аудит 2026-08-28: обложка строилась и выбрасывалась, когда задан photoUrl.
 *
 * Цепочка обложки в publish.ts смотрела на `p.photoUrl` только в последней
 * ветке («агент не дал ничего — рисуем авто-баннер»). Поэтому пара
 * `photoUrl` + `coverPrompt` шла так: слот `GENERATE_IMAGE` (6/час на роль)
 * списывался, вызывался gpt-image-1, буфер возвращался — и тут же терялся на
 * `if (p.photoUrl) photo = { url: p.photoUrl }`. С `coverTitle` вместо
 * промпта терялись ~2 секунды синхронного Resvg в общем процессе на 12 ботов.
 *
 * Сказать об этом было некому: `build-payload.ts` проверяет каждое поле по
 * отдельности и такую пару не отвергает, `tools-schema.ts` про взаимное
 * исключение не пишет, а действие возвращало ровно тот же `ok:true`, что и
 * публикация, где обложку действительно взяли. Модель платила за картинку,
 * получала её в канал не глядя и не узнавала, что её работа не пригодилась.
 *
 * Правка: при готовом `photoUrl` обложка не строится вовсе, а проигнорированные
 * поля называются в ответе — тем же механизмом `extra`, что `truncated` и
 * `cover_dropped` (см. аудит 2026-08-27).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { handlePublishToChannel } from "../lib/dispatch/publish.ts";
import { _resetRateLimits, checkRateLimit } from "../lib/rate-limits.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { db } from "../lib/db.ts";

const CH = -100828;
const CHAT = -828;
const URL_PHOTO = "https://example.test/ready.png";

const PUBLISH_SRC = readFileSync(
  new URL("../lib/dispatch/publish.ts", import.meta.url),
  "utf-8",
);

type Sent = { url?: string; buffer?: boolean };

function tgSpy(sent: Sent[]) {
  return {
    sendPhoto: async (_c: number, photo: any) => {
      sent.push(
        typeof photo === "string"
          ? { url: photo }
          : photo?.url
            ? { url: photo.url }
            : { buffer: true },
      );
      return { message_id: 1 };
    },
    sendMessage: async () => ({ message_id: 2 }),
  } as any;
}

const ctx = (tg: any, agentKey = "design") => ({
  agentKey,
  chatId: CHAT,
  telegram: tg,
  resolveUserbot: async () => null,
});

const prevKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
  registerTeamChannel(CH, "Team", CHAT);
  _resetRateLimits();
  // Ключа нет — generateImage бросает до сети (openai-image.ts:55-58). Нам и
  // нужен именно расход слота, а не поход в OpenAI из теста.
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  _resetRateLimits();
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

describe("готовый photoUrl отменяет работу над обложкой", () => {
  test("coverPrompt рядом с photoUrl не тратит слот GENERATE_IMAGE", async () => {
    const sent: Sent[] = [];
    // Бакет роли — 6/час. До правки шесть публикаций подряд выжигали его
    // целиком, причём ни одна из шести картинок в канал не попадала.
    for (let k = 0; k < 6; k++) {
      const r = await handlePublishToChannel(
        {
          channelId: CH,
          text: "Пост.",
          photoUrl: URL_PHOTO,
          coverPrompt: "обложка про аирдропы",
        } as any,
        ctx(tgSpy(sent)),
      );
      expect(r.ok).toBe(true);
    }
    expect(checkRateLimit("design", "GENERATE_IMAGE").ok).toBe(true);
    // И в канал всё это время уходил именно переданный URL.
    expect(sent).toEqual(Array.from({ length: 6 }, () => ({ url: URL_PHOTO })));
  });

  test("ответ называет поля обложки, которые не пригодились", async () => {
    const sent: Sent[] = [];
    const r = await handlePublishToChannel(
      {
        channelId: CH,
        text: "Пост.",
        photoUrl: URL_PHOTO,
        coverTitle: "Заголовок",
        coverSubtitle: "Подзаголовок",
      } as any,
      ctx(tgSpy(sent)),
    );
    expect(r.ok).toBe(true);
    const res = (r as any).result as Record<string, unknown>;
    expect(res.cover_ignored).toEqual(["coverTitle", "coverSubtitle"]);
    expect(String(res.cover_ignored_note)).toContain("photoUrl");
  });

  test("photoBase64 рядом с photoUrl тоже назван, а не проглочен", async () => {
    const sent: Sent[] = [];
    const r = await handlePublishToChannel(
      {
        channelId: CH,
        text: "Пост.",
        photoUrl: URL_PHOTO,
        photoBase64: Buffer.from("png").toString("base64"),
      } as any,
      ctx(tgSpy(sent)),
    );
    const res = (r as any).result as Record<string, unknown>;
    expect(res.cover_ignored).toEqual(["photoBase64"]);
    expect(sent).toEqual([{ url: URL_PHOTO }]);
  });

  test("обрезка текста и брошенная обложка уживаются в одном ответе", async () => {
    const sent: Sent[] = [];
    const r = await handlePublishToChannel(
      {
        channelId: CH,
        text: "Б".repeat(5000),
        photoUrl: URL_PHOTO,
        coverPrompt: "обложка",
      } as any,
      ctx(tgSpy(sent)),
    );
    const res = (r as any).result as Record<string, unknown>;
    expect(res.truncated).toBe(true);
    expect(res.cover_ignored).toEqual(["coverPrompt"]);
  });
});

describe("прежнее поведение не задето", () => {
  test("photoUrl без полей обложки — лишних полей в ответе нет", async () => {
    const sent: Sent[] = [];
    const r = await handlePublishToChannel(
      { channelId: CH, text: "Пост.", photoUrl: URL_PHOTO } as any,
      ctx(tgSpy(sent)),
    );
    expect(r.ok).toBe(true);
    const res = (r as any).result as Record<string, unknown>;
    expect(res.cover_ignored).toBeUndefined();
    expect(res.truncated).toBeUndefined();
    expect(sent).toEqual([{ url: URL_PHOTO }]);
  });

  test("без photoUrl обложка по-прежнему строится и уходит буфером", async () => {
    const sent: Sent[] = [];
    const r = await handlePublishToChannel(
      { channelId: CH, text: "Пост.", coverTitle: "Заголовок" } as any,
      ctx(tgSpy(sent)),
    );
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ buffer: true }]);
    expect((r as any).result?.cover_ignored).toBeUndefined();
  });
});

describe("применение", () => {
  test("цепочка обложки целиком закрыта проверкой photoUrl", () => {
    // Источник, а не поведение: веток внутри цепочки больше, чем разумно
    // покрыть публикациями, и любая новая обязана оказаться под тем же гейтом.
    const i = PUBLISH_SRC.indexOf("let coverBuf: Buffer | undefined;");
    expect(i).toBeGreaterThan(0);
    const chain = PUBLISH_SRC.slice(i, PUBLISH_SRC.indexOf("const PREMIUM_CAPTION_LIMIT", i));
    expect(chain).toContain("if (!p.photoUrl) {");
    // Внутренние `!p.photoUrl` стали тавтологией и обязаны уйти: гейт один.
    expect(chain.split("!p.photoUrl").length - 1).toBe(1);
  });
});
