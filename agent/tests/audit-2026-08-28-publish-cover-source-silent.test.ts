/**
 * Аудит 2026-08-28: молчание об отброшенном источнике обложки осталось на
 * ветке БЕЗ photoUrl.
 *
 * Аудит того же дня научил publish.ts называть поля обложки, которые не
 * пригодились, — но только когда задан `photoUrl`: `coverIgnored` считался
 * ровно под `p.photoUrl ? ... : []`. А сама цепочка выбора ниже —
 * `coverTitle → photoBase64 → coverPrompt → авто-баннер` — точно так же
 * выбирает ОДИН источник и молча роняет остальные.
 *
 * Больнее всего пара `coverTitle` + `photoBase64` без photoUrl: агент уже
 * сходил в GENERATE_IMAGE (6/час на роль), получил картинку, приложил её — и
 * она выбрасывается ради локального баннера по заголовку. Ответ при этом
 * неотличим от публикации, где приложенную картинку и взяли. Ровно тот же
 * класс, что чинили для photoUrl, и та же цена: модель платит за работу,
 * не узнаёт, что работа не пригодилась, и повторяет пару в следующем посте.
 *
 * Порядок предпочтения НЕ трогаем: это то, что реально уходит в живой канал,
 * и вопрос продуктовый. Чиним молчание.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { handlePublishToChannel } from "../lib/dispatch/publish.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { db } from "../lib/db.ts";

const CH = -100829;
const CHAT = -829;
const MARK = "готовая-картинка-агента";
const B64 = Buffer.from(MARK, "utf-8").toString("base64");

const SRC = readFileSync(new URL("../lib/dispatch/publish.ts", import.meta.url), "utf-8");

type Sent = { url?: string; bytes?: string };

function tgSpy(sent: Sent[]) {
  return {
    sendPhoto: async (_c: number, photo: any) => {
      sent.push(
        typeof photo === "string"
          ? { url: photo }
          : { bytes: Buffer.from(photo.source).toString("utf-8") },
      );
      return { message_id: 1 };
    },
    sendMessage: async () => ({ message_id: 2 }),
  } as any;
}

const ctx = (tg: any) => ({
  agentKey: "design",
  chatId: CHAT,
  telegram: tg,
  resolveUserbot: async () => null,
});

const prevKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
  registerTeamChannel(CH, "Team", CHAT);
  _resetRateLimits();
  // Ключа нет — generateImage бросает до сети (openai-image.ts:55-58).
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  _resetRateLimits();
  // bun гоняет каталог одним процессом — env обязан вернуться (CLAUDE.md §3.8 п.7).
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

async function publish(p: Record<string, unknown>, sent: Sent[]) {
  const r = await handlePublishToChannel(
    { channelId: CH, text: "Пост.", ...p } as any,
    ctx(tgSpy(sent)),
  );
  expect(r.ok).toBe(true);
  return (r as { result: Record<string, unknown> }).result;
}

describe("проигнорированный источник обложки назван и без photoUrl", () => {
  test(
    "coverTitle побеждает photoBase64 — и это сказано",
    async () => {
      const sent: Sent[] = [];
      const res = await publish({ coverTitle: "Заголовок", photoBase64: B64 }, sent);
      // В канал ушёл баннер, а не приложенная картинка — молча так и было.
      expect(sent.length).toBe(1);
      expect(sent[0]!.bytes).not.toBe(MARK);
      expect(res.cover_ignored).toEqual(["photoBase64"]);
      expect(String(res.cover_ignored_note)).toContain("photoBase64");
      expect(String(res.cover_ignored_note)).toContain("coverTitle");
    },
    30_000,
  );

  test("photoBase64 побеждает coverPrompt — слот GENERATE_IMAGE не тратится", async () => {
    const sent: Sent[] = [];
    const res = await publish({ photoBase64: B64, coverPrompt: "нарисуй что-нибудь" }, sent);
    expect(sent[0]!.bytes).toBe(MARK);
    expect(res.cover_ignored).toEqual(["coverPrompt"]);
  });

  test("подзаголовок без заголовка тоже не пропадает молча", async () => {
    const sent: Sent[] = [];
    const res = await publish({ photoBase64: B64, coverSubtitle: "Подзаголовок" }, sent);
    expect(sent[0]!.bytes).toBe(MARK);
    expect(res.cover_ignored).toEqual(["coverSubtitle"]);
  });

  test(
    "поля, которые баннер действительно использует, ignored не считаются",
    async () => {
      const sent: Sent[] = [];
      const res = await publish(
        { coverTitle: "Заголовок", coverSubtitle: "Подзаголовок", coverStyle: "dark" },
        sent,
      );
      expect(res.cover_ignored).toBeUndefined();
      expect(res.cover_ignored_note).toBeUndefined();
    },
    30_000,
  );

  test("один источник — ответ чистый, как и раньше", async () => {
    const sent: Sent[] = [];
    const res = await publish({ photoBase64: B64 }, sent);
    expect(sent[0]!.bytes).toBe(MARK);
    expect(res.cover_ignored).toBeUndefined();
  });

  test("пустая строка источником не считается", async () => {
    const sent: Sent[] = [];
    const res = await publish({ photoBase64: B64, coverPrompt: "" }, sent);
    expect(res.cover_ignored).toBeUndefined();
  });
});

describe("ветка photoUrl не тронута", () => {
  test("при готовом photoUrl по-прежнему перечисляются все поля обложки", async () => {
    const sent: Sent[] = [];
    const res = await publish(
      { photoUrl: "https://example.test/r.png", coverTitle: "З", photoBase64: B64 },
      sent,
    );
    expect(sent[0]!.url).toBe("https://example.test/r.png");
    expect(res.cover_ignored).toEqual(["coverTitle", "photoBase64"]);
    expect(String(res.cover_ignored_note)).toContain("photoUrl");
  });
});

describe("применение", () => {
  test("набор проигнорированных полей считается по победившему источнику", () => {
    expect(SRC).not.toContain(
      "const coverIgnored = p.photoUrl\n      ? COVER_FIELDS.filter",
    );
    expect(SRC).toContain("const usedCover = (");
  });

  test("порядок предпочтения не переставлен", () => {
    const from = SRC.indexOf("let coverBuf: Buffer | undefined;");
    const to = SRC.indexOf("const PREMIUM_CAPTION_LIMIT");
    expect(from).toBeGreaterThan(0);
    const chain = SRC.slice(from, to);
    const order = ["p.coverTitle", "p.photoBase64", "p.coverPrompt"].map((k) =>
      chain.indexOf(`if (${k})`),
    );
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });
});
