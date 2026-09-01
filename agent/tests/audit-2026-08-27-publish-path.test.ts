/**
 * Аудит 2026-08-27: путь публикации врал вызывающему.
 *
 * Пять мест, где действие возвращало `ok: true` (или невнятный отказ) при
 * результате, отличном от заказанного. Общий класс — тот же, что чинили
 * `truncated` в publish.ts и `enumField` в media.ts: расхождение
 * «попросили / получилось» обязано доехать до модели, иначе она отчитывается
 * человеку за то, чего не произошло, и чинить нечего.
 *
 * 1. media.ts — роль без обоих инструментов обложки СНАЧАЛА списывала слот и
 *    только потом падала. После шестого отказа за час чинимый диагноз
 *    («не выдан GENERATE_IMAGE», лечится /grant) подменялся нечинимым
 *    («бюджет картинок исчерпан»), и вместе с ним выгорал общий часовой бакет.
 * 2. publish.ts — осиротевший баннер в ПУБЛИЧНОМ канале не помечался как
 *    `sideEffect`, поэтому gateOrDispatch возвращал все слоты. Повтор клал ещё
 *    один баннер, потолка не было.
 * 3. publish.ts — Telegram отверг обложку, пост ушёл голым текстом, ответ
 *    неотличим от полной публикации с картинкой.
 * 4. build-payload.ts — `coverStyle: "minimal"` молча становился
 *    `illustrated`: в канал уходил яркий баннер вместо строгого.
 * 5. build-payload.ts — `priority: "90"` молча становился 0: срочная задача
 *    уезжала в самый низ очереди роли при `ok:true` с готовым taskId.
 * 6. channel.ts — роль, чей бот не запущен, исчезала из состава канала, не
 *    попадая ни в `added`, ни в `failed`.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateCoverPng } from "../lib/dispatch/media.ts";
import { handlePublishToChannel } from "../lib/dispatch/publish.ts";
import { handleCreateTeamChannel } from "../lib/dispatch/channel.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { _resetRateLimits, checkRateLimit } from "../lib/rate-limits.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { db } from "../lib/db.ts";

const CH = -100827;
const CHAT = -827;
const ctx = { agentKey: "smm" };

afterEach(() => _resetRateLimits());

// ─── 1. отказ по роли не должен стоить бюджета ────────────────────────────

describe("обложка: отказ по роли — не расход бюджета", () => {
  const deps = () => {
    const calls = { paid: 0, cheap: 0 };
    return {
      calls,
      deps: {
        generate: async () => { calls.paid++; return Buffer.from("png"); },
        fallbackSvg: async () => { calls.cheap++; return "<svg/>"; },
      },
    };
  };

  test("семь отказов подряд — бакет нетронут, диагноз не меняется", async () => {
    // Лимит роли — 6 в час. Раньше седьмой вызов сообщал «бюджет картинок
    // исчерпан» вместо «роли не выдан GENERATE_IMAGE», то есть подменял
    // чинимую причину нечинимой, и делал это ПОСЛЕ того, как сжёг слоты.
    const { calls, deps: d } = deps();
    for (let k = 0; k < 7; k++) {
      await expect(generateCoverPng("промпт", "smm", d)).rejects.toThrow(
        /не выдан ни GENERATE_IMAGE, ни GENERATE_SVG_IMAGE/,
      );
    }
    expect(calls.paid).toBe(0);
    expect(calls.cheap).toBe(0);
    expect(checkRateLimit("smm", "GENERATE_IMAGE").ok).toBe(true);
  });

  test("отказ не съедает общий часовой бакет ролей", async () => {
    const { deps: d } = deps();
    for (let k = 0; k < 7; k++) {
      await generateCoverPng("промпт", "copy", d).catch(() => {});
    }
    // design ходит в тот же global:GENERATE_IMAGE (30/час) — он обязан остаться
    // при своих, чужие отказы его не касаются.
    expect(checkRateLimit("design", "GENERATE_IMAGE").ok).toBe(true);
  });

  test("роль с выданными инструментами по-прежнему платит", async () => {
    const { calls, deps: d } = deps();
    for (let k = 0; k < 6; k++) await generateCoverPng("промпт", "design", d);
    expect(calls.paid).toBe(6);
    expect(checkRateLimit("design", "GENERATE_IMAGE").ok).toBe(false);
  });
});

// ─── 2-3. честность ответа публикации ─────────────────────────────────────

const LONG = "А".repeat(1200); // > TG_CAPTION_LIMIT (1024) → фото + текст врозь
const err400 = (desc: string) =>
  Object.assign(new Error(desc), { response: { error_code: 400, description: desc } });

const publishCtx = (tg: any) => ({
  agentKey: "smm",
  chatId: CHAT,
  telegram: tg,
  resolveUserbot: async () => null,
});

const basePayload = {
  channelId: CH,
  text: "Короткий пост.",
  coverTitle: "Заголовок",
} as any;

describe("публикация: осиротевший баннер — это побочный эффект", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
    registerTeamChannel(CH, "Team", CHAT);
  });

  test("баннер остался в канале, текст не ушёл → sideEffect", async () => {
    const tg = {
      sendPhoto: async () => ({ message_id: 42 }),
      sendMessage: async () => { throw new Error("сеть отвалилась"); },
      deleteMessage: async () => { throw new Error("message can't be deleted"); },
    } as any;
    const r = await handlePublishToChannel({ ...basePayload, text: LONG }, publishCtx(tg));
    expect(r.ok).toBe(false);
    // Без флага gateOrDispatch возвращал слоты, и повторы клали в публичный
    // канал по баннеру за раз без всякого потолка.
    expect((r as any).sideEffect).toBe(true);
    expect((r as any).error).toContain("message_id=42");
  });

  test("баннер удалён — канал чист, флага нет", async () => {
    const deleted: number[] = [];
    const tg = {
      sendPhoto: async () => ({ message_id: 43 }),
      sendMessage: async () => { throw new Error("сеть отвалилась"); },
      deleteMessage: async (_c: number, m: number) => { deleted.push(m); return true; },
    } as any;
    const r = await handlePublishToChannel({ ...basePayload, text: LONG }, publishCtx(tg));
    expect(r.ok).toBe(false);
    expect(deleted).toEqual([43]);
    expect((r as any).sideEffect).toBeUndefined();
  });

  test("gateOrDispatch действительно читает этот флаг", () => {
    // Флаг бесполезен, если его никто не смотрит: пиним обе стороны контракта.
    const src = readFileSync(join(import.meta.dir, "..", "lib", "action-dispatch.ts"), "utf-8");
    expect(src).toMatch(/if\s*\(res\.sideEffect\)\s*refundNeeded\s*=\s*false/);
  });
});

describe("публикация: отвергнутая обложка видна в ответе", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
    registerTeamChannel(CH, "Team", CHAT);
  });

  test("Telegram отверг картинку → cover_dropped в результате", async () => {
    const sent: string[] = [];
    const tg = {
      sendPhoto: async () => { throw err400("IMAGE_PROCESS_FAILED"); },
      sendMessage: async (_c: number, t: string) => { sent.push(t); return { message_id: 7 }; },
    } as any;
    const r = await handlePublishToChannel(basePayload, publishCtx(tg));
    expect(r.ok).toBe(true);
    expect(sent.length).toBe(1);
    const res = (r as any).result as Record<string, unknown>;
    expect(res.cover_dropped).toBe(true);
    expect(String(res.cover_error)).toContain("IMAGE_PROCESS_FAILED");
    expect(String(res.cover_note)).toContain("без картинки");
  });

  test("обложка ушла — никаких лишних полей", async () => {
    const tg = {
      sendPhoto: async () => ({ message_id: 8 }),
      sendMessage: async () => { throw new Error("не должен вызываться"); },
    } as any;
    const r = await handlePublishToChannel(basePayload, publishCtx(tg));
    expect(r.ok).toBe(true);
    const res = (r as any).result as Record<string, unknown>;
    expect(res.cover_dropped).toBeUndefined();
    expect(res.truncated).toBeUndefined();
  });

  test("обрезка и потеря обложки уживаются в одном ответе", async () => {
    // `truncated` считалось ранним return'ом — новая ветка не должна была её
    // вытеснить, обе причины расхождения обязаны приехать вместе.
    const tg = {
      sendPhoto: async () => { throw err400("PHOTO_INVALID_DIMENSIONS"); },
      sendMessage: async () => ({ message_id: 9 }),
    } as any;
    const huge = "Б".repeat(5000);
    const r = await handlePublishToChannel({ ...basePayload, text: huge }, publishCtx(tg));
    expect(r.ok).toBe(true);
    const res = (r as any).result as Record<string, unknown>;
    expect(res.truncated).toBe(true);
    expect(res.cover_dropped).toBe(true);
  });

  test("не-фото 400 по-прежнему проваливает публикацию, а не глотается", async () => {
    const tg = {
      sendPhoto: async () => { throw err400("chat not found"); },
      sendMessage: async () => ({ message_id: 10 }),
    } as any;
    const r = await handlePublishToChannel(basePayload, publishCtx(tg));
    expect(r.ok).toBe(false);
  });
});

// ─── 4. coverStyle ────────────────────────────────────────────────────────

describe("coverStyle: чужое значение — отказ, не подмена", () => {
  for (const bad of ["minimal", "Clean", "clean ", "строгий", 3, true]) {
    test(`${JSON.stringify(bad)} отвергается`, () => {
      const r = buildPayload(
        "PUBLISH_TO_CHANNEL",
        { channelId: CH, text: "пост", coverStyle: bad },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain("coverStyle");
    });
  }

  test("законные значения проходят как есть", () => {
    for (const good of ["illustrated", "clean"] as const) {
      const r = buildPayload(
        "PUBLISH_TO_CHANNEL",
        { channelId: CH, text: "пост", coverStyle: good },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect((r as any).payload.coverStyle).toBe(good);
    }
  });

  test("поле необязательное — без него дефолт illustrated", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { channelId: CH, text: "пост" }, ctx);
    expect(r.ok).toBe(true);
    expect((r as any).payload.coverStyle).toBe("illustrated");
  });
});

// ─── 5. priority ──────────────────────────────────────────────────────────

describe("priority: мусор — отказ, не тихий ноль", () => {
  for (const bad of ["90", 1.5, -1, 101, 100000, true, "high"]) {
    test(`${JSON.stringify(bad)} отвергается`, () => {
      const r = buildPayload("CREATE_TASK", { title: "Срочно", priority: bad }, ctx);
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain("priority");
    });
  }

  test("границы диапазона законны", () => {
    for (const good of [0, 50, 100]) {
      const r = buildPayload("CREATE_TASK", { title: "Задача", priority: good }, ctx);
      expect(r.ok).toBe(true);
      expect((r as any).payload.priority).toBe(good);
    }
  });

  test("без поля — прежний дефолт 0", () => {
    const r = buildPayload("CREATE_TASK", { title: "Задача" }, ctx);
    expect(r.ok).toBe(true);
    expect((r as any).payload.priority).toBe(0);
  });
});

// ─── 6. состав команды в канале ───────────────────────────────────────────

describe("CREATE_TEAM_CHANNEL: пропавшие роли называются вслух", () => {
  const ub = {
    isNoop: false,
    createTeamChannel: async (title: string, _about: string, usernames: string[]) => ({
      channelId: -100828,
      title,
      added: usernames,
      failed: [],
    }),
  } as any;

  const chanCtx = (known: Record<string, string>) => ({
    agentKey: "orchestrator",
    chatId: CHAT,
    resolveAgent: (role: string) =>
      known[role] ? ({ username: known[role] } as any) : undefined,
    resolveUserbot: async () => ub,
  });

  test("нерезолвнутая роль попадает в ответ, а не исчезает", async () => {
    const r = await handleCreateTeamChannel(
      { title: "Канал", roles: ["smm", "backend"] } as any,
      chanCtx({ smm: "@smm_bot", orchestrator: "@orc_bot" }),
    );
    expect(r.ok).toBe(true);
    const res = (r as any).result as Record<string, unknown>;
    expect(res.unresolved).toEqual(["backend"]);
    expect(String(res.note)).toContain("backend");
  });

  test("все роли на месте — поля unresolved нет", async () => {
    const r = await handleCreateTeamChannel(
      { title: "Канал", roles: ["smm"] } as any,
      chanCtx({ smm: "@smm_bot", orchestrator: "@orc_bot" }),
    );
    expect(r.ok).toBe(true);
    expect(((r as any).result as Record<string, unknown>).unresolved).toBeUndefined();
  });

  test("нет контролёра — канал не создаётся вовсе", async () => {
    let created = false;
    const r = await handleCreateTeamChannel(
      { title: "Канал", roles: ["smm"] } as any,
      {
        ...chanCtx({ smm: "@smm_bot" }),
        resolveUserbot: async () =>
          ({
            isNoop: false,
            createTeamChannel: async () => {
              created = true;
              return { channelId: -1, title: "x", added: [], failed: [] };
            },
          }) as any,
      },
    );
    expect(r.ok).toBe(false);
    // Канал неидемпотентен: создать и «дорезолвить» контролёра потом нельзя.
    expect(created).toBe(false);
    expect((r as any).error).toContain("orchestrator");
  });
});
