/**
 * Аудит 2026-08-12: три дыры на пути «апрув → публикация в канал».
 *
 * 1) Подпись к баннеру уходила в client.sendFile как есть, без оглядки на
 *    лимит Telegram (1024 символа без Premium, 1000 с запасом у нас в коде).
 *    Замер на реальной форме дайджеста (buildFinalText, plainTelegramLength):
 *      4 статьи, blurb 180 → plain 1209
 *      4 статьи, blurb 220 → plain 1369
 *      3 статьи, blurb 200 → plain 1008
 *    То есть обычный день из четырёх новостей уже не влезает: MTProto отвечает
 *    MEDIA_CAPTION_TOO_LONG, runApprovedPublish ловит это как publish_failed,
 *    а publishStartedAt уже проставлен — автоповтор запрещён, и дайджест не
 *    уйдёт вообще никогда без ручного вмешательства в pending.json.
 *
 * 2) Реакция ✅ проверялась ПЕРВОЙ и возвращала true сразу, до чтения ответов.
 *    Владелец, поставивший ✅ и следом написавший «стоп, не публикуй»,
 *    получал публикацию. Правило файла — «есть содержательный текст, значит
 *    это правка, по умолчанию не публикуем» — на реакцию не распространялось.
 *    Плюс премиальная реакция (ReactionCustomEmoji, у неё documentId вместо
 *    emoticon) не считалась апрувом вовсе.
 *
 * 3) Дата в тексте поста и на баннере бралась в момент апрува и по локальному
 *    времени процесса. Замер: черновик от 11.08 20:05 UTC, апрув утром 12.08 →
 *    в посте «12 августа 2026» при статьях за 11-е. И тот же самый момент
 *    (2026-08-12T21:30Z) рендерился как «13 августа 2026» на машине с
 *    Europe/Moscow и как «12 августа 2026» на VPS с UTC.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPTION_PLAIN_LIMIT,
  buildFinalText,
  decideApproval,
  isApproved,
  splitForCaption,
  sendDigest,
} from "../tools/approve-poll.ts";
import { ruDate } from "../tools/daily-draft.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

function pendingWith(count: number, blurbLen: number): PendingDraft {
  return {
    createdAt: "2026-03-04T20:05:00.000Z",
    previewMsgId: 42,
    dayTitle: "Дайджест: главное за сутки в крипте и AI",
    articles: Array.from({ length: count }, (_, i) => ({
      title: `Заголовок новости номер ${i + 1} про крипту и искусственный интеллект`,
      date: "2026-03-04T20:00:00.000Z",
      summary: "s",
      body: "b",
      items: [],
      sourceCount: 3,
      emoji: "🔥",
      blurb: `Новость ${i + 1}. ` + "Ц".repeat(blurbLen),
      siteId: `2026-03-04-novost-${i + 1}`,
    })),
  } as PendingDraft;
}

describe("подпись к баннеру против лимита Telegram", () => {
  test("текст в лимите остаётся одним куском", () => {
    const text = buildFinalText(pendingWith(2, 60));
    expect(plainTelegramLength(text)).toBeLessThanOrEqual(CAPTION_PLAIN_LIMIT);
    expect(splitForCaption(text)).toEqual([text]);
  });

  test("дайджест из четырёх новостей режется, а не отваливается по ошибке", () => {
    const text = buildFinalText(pendingWith(4, 220));
    // Замер до правки: 1369 plain — сервер отвечал MEDIA_CAPTION_TOO_LONG.
    expect(plainTelegramLength(text)).toBeGreaterThan(CAPTION_PLAIN_LIMIT);

    const parts = splitForCaption(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(plainTelegramLength(p)).toBeLessThanOrEqual(CAPTION_PLAIN_LIMIT);
    }
  });

  test("ни одна новость и ни одна ссылка не теряются", () => {
    const pending = pendingWith(4, 220);
    const joined = splitForCaption(buildFinalText(pending)).join("\n");
    for (const a of pending.articles) {
      expect(joined).toContain(a.title);
      expect(joined).toContain(`/digest/${a.siteId}`);
    }
    expect(joined).toContain("Copyright");
  });

  test("абзац длиннее лимита сам по себе тоже укладывается", () => {
    const parts = splitForCaption("А".repeat(3000));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(plainTelegramLength(p)).toBeLessThanOrEqual(CAPTION_PLAIN_LIMIT);
    }
  });
});

interface SendCall {
  kind: "photo" | "message";
  text: string;
}

function recorder(opts: { failPhotoTimes?: number } = {}) {
  const calls: SendCall[] = [];
  let photoFails = opts.failPhotoTimes ?? 0;
  return {
    calls,
    io: {
      async sendPhoto(caption: string): Promise<number> {
        calls.push({ kind: "photo", text: caption });
        if (photoFails > 0) {
          photoFails--;
          throw new Error("MEDIA_CAPTION_TOO_LONG");
        }
        return 555;
      },
      async sendMessage(text: string): Promise<void> {
        calls.push({ kind: "message", text });
      },
    },
  };
}

describe("sendDigest", () => {
  const banner = Buffer.from([1, 2, 3]);

  test("короткий дайджест — одно фото, никаких добивок", async () => {
    const text = buildFinalText(pendingWith(2, 60));
    const r = recorder();
    const { msgId } = await sendDigest(text, banner, r.io);
    expect(msgId).toBe(555);
    expect(r.calls.map((c) => c.kind)).toEqual(["photo"]);
    expect(r.calls[0]!.text).toBe(text);
  });

  test("длинный — фото с подписью в лимите плюс хвост сообщениями по порядку", async () => {
    const text = buildFinalText(pendingWith(4, 220));
    const r = recorder();
    const { msgId } = await sendDigest(text, banner, r.io);
    expect(msgId).toBe(555);
    expect(r.calls[0]!.kind).toBe("photo");
    expect(plainTelegramLength(r.calls[0]!.text)).toBeLessThanOrEqual(
      CAPTION_PLAIN_LIMIT,
    );
    expect(r.calls.length).toBeGreaterThan(1);
    expect(r.calls.slice(1).every((c) => c.kind === "message")).toBe(true);
    expect(r.calls.map((c) => c.text).join("\n")).toContain("Copyright");
  });

  test("MEDIA_CAPTION_TOO_LONG — один повтор с более короткой подписью", async () => {
    const text = buildFinalText(pendingWith(4, 220));
    const r = recorder({ failPhotoTimes: 1 });
    const { msgId } = await sendDigest(text, banner, r.io);
    expect(msgId).toBe(555);
    const photos = r.calls.filter((c) => c.kind === "photo");
    expect(photos.length).toBe(2);
    expect(plainTelegramLength(photos[1]!.text)).toBeLessThan(
      plainTelegramLength(photos[0]!.text),
    );
    // Ничего не потеряли: всё, что не влезло, ушло следом.
    expect(r.calls.map((c) => c.text).join("\n")).toContain("Copyright");
  });

  test("другая ошибка отправки пробрасывается наверх", async () => {
    const io = {
      async sendPhoto(): Promise<number> {
        throw new Error("FLOOD_WAIT_42");
      },
      async sendMessage(): Promise<void> {},
    };
    await expect(sendDigest("привет", banner, io)).rejects.toThrow("FLOOD_WAIT_42");
  });
});

describe("decideApproval", () => {
  test("реакция ✅ — апрув", () => {
    expect(decideApproval({ reaction: true, replies: [] }).approved).toBe(true);
  });

  test("ответ «+» — апрув", () => {
    expect(decideApproval({ reaction: false, replies: ["+"] }).approved).toBe(true);
  });

  test("ничего — не апрув", () => {
    expect(decideApproval({ reaction: false, replies: [] }).approved).toBe(false);
  });

  test("✅ и следом «стоп, не публикуй» — НЕ публикуем", () => {
    const d = decideApproval({
      reaction: true,
      replies: ["стоп, не публикуй, поправлю вторую новость"],
    });
    // Старое поведение: реакция возвращала true до чтения ответов.
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("veto");
  });

  test("«+» и следом правка — тоже не публикуем", () => {
    expect(
      decideApproval({ reaction: false, replies: ["+", "хотя нет, убери третью"] })
        .approved,
    ).toBe(false);
  });

  test("пустые ответы (стикер, фото) вето не считаются", () => {
    expect(
      decideApproval({ reaction: true, replies: ["", "   "] }).approved,
    ).toBe(true);
  });

  test("ответы не прочитались — не публикуем, ждём следующего тика", () => {
    const d = decideApproval({ reaction: true, replies: null });
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("replies_unreadable");
  });
});

function fakeClient(opts: {
  reactions?: unknown[];
  replies?: string[];
  customEmojiAlt?: string;
  repliesThrow?: boolean;
}): any {
  return {
    async getInputEntity() {
      return { me: true };
    },
    async getMessages(_peer: unknown, args: any) {
      if (args?.ids) {
        return [{ reactions: { results: opts.reactions ?? [] } }];
      }
      if (opts.repliesThrow) throw new Error("replies unavailable");
      return (opts.replies ?? []).map((message) => ({
        message,
        replyTo: { replyToMsgId: 42 },
      }));
    },
    async invoke() {
      if (!opts.customEmojiAlt) return [];
      return [{ attributes: [{ alt: opts.customEmojiAlt }] }];
    },
  };
}

describe("isApproved на живой форме ответа Telegram", () => {
  test("обычная реакция ✅", async () => {
    const c = fakeClient({ reactions: [{ reaction: { emoticon: "✅" } }] });
    expect(await isApproved(c, 42)).toBe(true);
  });

  test("премиальная реакция ✅ (custom emoji с documentId)", async () => {
    const c = fakeClient({
      reactions: [{ reaction: { documentId: "5312345678901234567" } }],
      customEmojiAlt: "✅",
    });
    // Старое поведение: смотрели только emoticon, премиум апрувом не считался.
    expect(await isApproved(c, 42)).toBe(true);
  });

  test("премиальная реакция не про апрув", async () => {
    const c = fakeClient({
      reactions: [{ reaction: { documentId: "5399999999999999999" } }],
      customEmojiAlt: "🔥",
    });
    expect(await isApproved(c, 42)).toBe(false);
  });

  test("✅ плюс возражение в ответе — не апрув", async () => {
    const c = fakeClient({
      reactions: [{ reaction: { emoticon: "✅" } }],
      replies: ["подожди, перепиши заголовок"],
    });
    expect(await isApproved(c, 42)).toBe(false);
  });

  test("ответы недоступны — не апрув, даже с реакцией", async () => {
    const c = fakeClient({
      reactions: [{ reaction: { emoticon: "✅" } }],
      repliesThrow: true,
    });
    expect(await isApproved(c, 42)).toBe(false);
  });
});

describe("дата дайджеста", () => {
  test("в посте стоит дата черновика, а не момента апрува", () => {
    const pending = pendingWith(2, 60);
    const text = buildFinalText(pending);
    // createdAt = 2026-03-04, апрув происходит «сегодня».
    expect(text).toContain("4 марта 2026");
    expect(text).not.toContain(ruDate());
  });

  test("ruDate не зависит от часового пояса процесса", () => {
    // 2026-08-12T21:30Z — это уже 13 августа в Москве. На VPS с TZ=UTC старый
    // код печатал «12 августа 2026», на машине разработчика — «13 августа».
    const script = `import { ruDate } from ${JSON.stringify(
      new URL("../tools/daily-draft.ts", import.meta.url).pathname,
    )};
console.log(ruDate(new Date("2026-08-12T21:30:00.000Z")));`;
    const out = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, TZ: "UTC" },
    });
    expect(new TextDecoder().decode(out.stdout).trim()).toBe("13 августа 2026");
    // Часовой пояс задаётся процессу при старте, поменять его на лету нельзя —
    // отсюда отдельный `bun -e`, который поднимает daily-draft.ts со всеми его
    // импортами. На этой машине ~3 с в тишине, под полным прогоном упирался в
    // дефолтные 5000 мс bun и падал по таймауту, а не по утверждению. Запас
    // явный: `spawnSync` держит event-loop, прервать тест bun всё равно не смог
    // бы.
  }, 30_000);
});
