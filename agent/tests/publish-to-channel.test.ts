/**
 * PUBLISH_TO_CHANNEL: человек в контуре (гейт) + постить можно ТОЛЬКО в
 * team-каналы (anti-exfil в хендлере).
 *
 * Два разных рубежа, и проверять их надо порознь. Аудит 2026-08-04 нашёл, что
 * первого не было вовсе: миграция 038 сеет allowed=1, requires_approval=0, в
 * SEMI_AUTO_RISKY действие не входило, дефолтная автономия — semi_auto, и гейт
 * возвращал `allow`. Пост подписчикам публичного канала уходил без человека,
 * тогда как сообщение в приватный чат команды апрува требовало. Теперь
 * действие в ALWAYS_APPROVE_ACTIONS — как REVIEW_AND_MERGE_PR, по той же
 * причине необратимости.
 *
 * Anti-exfil при этом остаётся нужен: после апрува пост исполняется
 * dispatchAndAudit'ом напрямую, мимо гейта (executeApproved, commands.ts), так
 * что реестр team-каналов — единственное, что стоит между апрувом «опубликуй»
 * и произвольным channelId в payload'е.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { dispatchAction, ensureChannelFooter, type DispatchResult } from "../lib/action-dispatch.ts";
import { registerTeamChannel, isTeamChannel } from "../lib/team-channels.ts";
import { ALWAYS_APPROVE_ACTIONS } from "../lib/permissions.ts";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";
import { db } from "../lib/db.ts";

/** Длина plain-текста готового HTML — так её считает Telegram. */
const plainLenHtml = (html: string): number =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").length;

/** Длина так, как её считает Telegram: plain-текст после разбора разметки. */
const plainLen = (md: string): number => plainLenHtml(mdToTelegramHtml(md));

/**
 * DispatchResult — объединение, размеченное по `ok`, и expect() тип не сужает.
 * Разворачиваем ветку провала явно, чтобы читать `error`.
 */
const failed = (r: DispatchResult): Extract<DispatchResult, { ok: false }> =>
  r as Extract<DispatchResult, { ok: false }>;

const fakeTg = () => {
  const sent: any[] = [];
  return {
    sent,
    tg: {
      sendMessage: (chatId: number, text: string) => { sent.push({ chatId, text }); return Promise.resolve({ message_id: 1 }); },
      // Без юзербота пост уходит фото-обложкой (авто-баннер) + подпись.
      sendPhoto: (chatId: number, _photo: unknown, extra: any) => { sent.push({ chatId, text: extra?.caption }); return Promise.resolve({ message_id: 2 }); },
    } as any,
  };
};

describe("PUBLISH_TO_CHANNEL: человек в контуре", () => {
  beforeEach(() => { db.prepare("DELETE FROM team_channels WHERE channel_id IN (-100777, -100999)").run(); });

  test("публикация не уходит сама — ждёт апрува", async () => {
    registerTeamChannel(-100777, "Team Ch", -1);
    const { tg, sent } = fakeTg();
    const out = JSON.parse(await executeTool(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: "**Крючок.** Живой пост." },
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    ));
    // Главное — в канал ничего не ушло.
    expect(sent.length).toBe(0);
    expect(out.ok).not.toBe(true);
  });

  test("апрув обязателен в любом режиме автономии", () => {
    // Не в SEMI_AUTO_RISKY: там `auto` пропускал бы пост насквозь, а правило
    // проекта — публичный контент только через draft+approve, всегда.
    expect(ALWAYS_APPROVE_ACTIONS.has("PUBLISH_TO_CHANNEL")).toBe(true);
  });
});

describe("PUBLISH_TO_CHANNEL anti-exfil (после апрува)", () => {
  beforeEach(() => { db.prepare("DELETE FROM team_channels WHERE channel_id IN (-100777, -100999)").run(); });

  test("в чужой (не team) канал → forbidden, не отправляет", async () => {
    const { tg, sent } = fakeTg();
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100999, text: "leak" } as any,
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    );
    expect(out.ok).toBe(false);
    expect(failed(out).error).toContain("team-каналов");
    expect(sent.length).toBe(0);
  });

  test("в зарегистрированный team-канал → постит", async () => {
    registerTeamChannel(-100777, "Team Ch", -1);
    expect(isTeamChannel(-100777)).toBe(true);
    const { tg, sent } = fakeTg();
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: "**Крючок.** Живой пост." } as any,
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    );
    expect(out.ok).toBe(true);
    expect(sent[0].chatId).toBe(-100777);
  });

  test("пост на лимите + канонический футер не уезжает за 4096", async () => {
    // Аудит 2026-08-04: обрезка до 4096 живёт в build-payload.ts, а футер
    // приклеивается ПОСЛЕ неё, в самом хендлере. Канонический футер длиннее
    // агентского (в нём ссылки), поэтому пост, ровно уложившийся в лимит,
    // после замены футера снова уезжал за 4096 → Telegram отвечал 400
    // «message is too long» и публикация падала целиком. Детерминированно:
    // достаточно одного длинного дайджеста.
    registerTeamChannel(-100777, "Team Ch", -1);

    // Блоки по 400 символов — режется целыми пунктами, поэтому их нужно
    // несколько. Плюс агентский футер, который ensureChannelFooter заменит.
    const block = "Пункт дайджеста. ".repeat(23).trim(); // ~390 plain
    const FOOTER_LINE = "© 2026 DeLabs";
    let body = Array.from({ length: 10 }, () => block).join("\n\n");
    // Дотягиваем вплотную к лимиту: баг воспроизводится ровно на посте, который
    // сам в 4096 уложился, но перестаёт укладываться после подмены футера.
    body += ".".repeat(Math.max(0, 4090 - FOOTER_LINE.length - 2 - plainLen(body)));
    const raw = `${body}\n\n${FOOTER_LINE}`;

    // Предпосылка бага: сам текст в лимит укладывается, а с каноническим
    // футером — уже нет. Без этого тест ничего бы не проверял.
    expect(plainLen(raw)).toBeLessThanOrEqual(4096);
    expect(plainLen(ensureChannelFooter(raw))).toBeGreaterThan(4096);

    const { tg, sent } = fakeTg();
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: raw } as any,
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    );

    expect(out.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      // В fakeTg приходит уже готовый HTML (sendWithHtml конвертирует до send),
      // поэтому меряем его напрямую. Прогонять его через mdToTelegramHtml ещё
      // раз нельзя: конвертер экранирует `<a href="…">` и длинные URL начинают
      // считаться видимым текстом — счёт раздувается на пару сотен символов.
      // Раньше это было незаметно, потому что обрезка оставляла запас.
      expect(plainLenHtml(m.text ?? "")).toBeLessThanOrEqual(4096);
    }
    // Обрезали тело, а не футер: ссылки сообщества должны уцелеть.
    expect(sent[sent.length - 1].text).toContain("Copyright");
  });

  test("канал соседнего чата → forbidden, не отправляет", async () => {
    // Аудит 2026-08-04: реестр проверялся глобально, created_by_chat не
    // учитывался. Все остальные исходящие действия пинятся к чату-триггеру —
    // публикация была единственной, где инъекция в одном командном чате
    // дотягивалась до канала соседнего.
    registerTeamChannel(-100777, "Team Ch", -1);
    const { tg, sent } = fakeTg();
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: "чужой канал" } as any,
      { agentKey: "smm", chatId: -2, telegram: tg } as any,
    );
    expect(out.ok).toBe(false);
    expect(failed(out).error).toContain("другого чата");
    expect(sent.length).toBe(0);
  });
});

/**
 * Аудит 2026-08-07: длинный пост в Bot-API фолбэке — это ДВЕ отправки
 * (фото, затем текст). Транзакций у Telegram нет: если вторая падала, в канале
 * оставался голый баннер без текста, действие репортилось как ошибка, а повтор
 * добавлял второй баннер. Теперь осиротевшее фото сносится компенсацией.
 */
describe("PUBLISH_TO_CHANNEL: половинчатая публикация", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = -100777").run();
    registerTeamChannel(-100777, "Team Ch", -1);
  });

  /** Текст заведомо длиннее подписи (1024) → ветка «фото + сообщение». */
  const longText = "Абзац дайджеста про рынок. ".repeat(60);

  test("текст не ушёл → баннер удаляется, действие падает честно", async () => {
    const calls: string[] = [];
    const tg = {
      sendPhoto: () => { calls.push("photo"); return Promise.resolve({ message_id: 555 }); },
      sendMessage: () => { calls.push("text"); return Promise.reject(new Error("Bad Request: 400")); },
      deleteMessage: (chatId: number, messageId: number) => {
        calls.push(`delete:${chatId}:${messageId}`);
        return Promise.resolve(true);
      },
    } as any;
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: longText } as any,
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    );
    expect(out.ok).toBe(false);
    expect(failed(out).error).toContain("баннер удалён");
    // Именно тот баннер, что успели отправить, и именно в том канале.
    expect(calls).toEqual(["photo", "text", "delete:-100777:555"]);
  });

  test("если и удалить не вышло — в ошибке есть message_id осиротевшего баннера", async () => {
    const tg = {
      sendPhoto: () => Promise.resolve({ message_id: 777 }),
      sendMessage: () => Promise.reject(new Error("Bad Request: 400")),
      deleteMessage: () => Promise.reject(new Error("message can't be deleted")),
    } as any;
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: longText } as any,
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    );
    expect(out.ok).toBe(false);
    // Человеку нужно знать ОБА факта: текст не ушёл и мусор остался.
    expect(failed(out).error).toContain("777");
    expect(failed(out).error).toContain("вручную");
  });

  test("короткий пост со ссылками остаётся одним сообщением (длина по plain)", async () => {
    // Сырой markdown длиннее 1024 из-за url'ов, plain — заметно короче.
    const withLinks = Array.from(
      { length: 18 },
      (_, i) => `[Пункт дайджеста номер ${i}](https://delabs.space/very/long/path/${i}/details)`,
    ).join("\n\n");
    expect(withLinks.length).toBeGreaterThan(1024);
    expect(plainLen(withLinks)).toBeLessThan(1024);

    const calls: string[] = [];
    const tg = {
      sendPhoto: (_c: number, _p: unknown, extra: any) => {
        calls.push(`photo:${extra?.caption ? "with-caption" : "bare"}`);
        return Promise.resolve({ message_id: 2 });
      },
      sendMessage: () => { calls.push("text"); return Promise.resolve({ message_id: 1 }); },
    } as any;
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: -100777, text: withLinks } as any,
      { agentKey: "smm", chatId: -1, telegram: tg } as any,
    );
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["photo:with-caption"]);
  });
});
