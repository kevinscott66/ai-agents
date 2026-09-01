/**
 * Аудит 2026-08-20: buildPayload молча чинил три сорта кривого входа вместо
 * того, чтобы отказать. Общая доктрина файла сформулирована в шапке
 * PUBLISH_TEXT_MAX_RAW: «либо целиком дальше, либо явный отказ» — молчаливая
 * подмена хуже отказа, потому что модель не видит, что её просьбу изменили, и
 * повторить корректно не может.
 *
 * 1) CREATE_TEAM_CHANNEL, roles не-массив. Разбор ролей целиком стоял под
 *    `if (Array.isArray(i.roles))`, поэтому `roles: "smm,design"` (обычная
 *    ошибка формата) не отвергался, а становился `[]` и давал ok:true. Дальше
 *    action-dispatch всегда добавляет orchestrator — значит usernames не пуст,
 *    отказа нет, и в Telegram появляется РЕАЛЬНЫЙ публичный канал с одним
 *    админом вместо запрошенной команды. Создание канала необратимо.
 *
 * 2) LIST_RECENT_MESSAGES, неизвестные kinds. Фильтр `.filter(allowed.has)`
 *    выбрасывал незнакомое молча, а список целиком из неизвестных схлопывался
 *    в undefined — и ниже подставлялся дефолт ["service"]
 *    (dispatch/misc.ts:78). Модель, спросившая kinds: ["user","agent"],
 *    получала выборку служебных сообщений и делала вывод «в чате пусто».
 *
 * 3) PUBLISH_TO_CHANNEL, поля обложки. coverPrompt/coverTitle/coverSubtitle
 *    резались `.slice()` без единого слова. Заголовок в 190 символов уезжал в
 *    генератор картинки обрезанным на полуслове, пост с этой картинкой уходил
 *    в публичный канал, а действие рапортовало успех.
 */
import { test, expect, describe } from "bun:test";
import { buildPayload } from "../lib/dispatch/build-payload.ts";

const ctx = { agentKey: "orchestrator" };

describe("CREATE_TEAM_CHANNEL: roles неверного типа — отказ, не пустой список", () => {
  test("строка вместо массива отвергается", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL", { title: "Команда", roles: "smm,design" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("roles");
  });

  test("объект вместо массива отвергается", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL", { title: "Команда", roles: { smm: true } }, ctx);
    expect(r.ok).toBe(false);
  });

  test("число вместо массива отвергается", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL", { title: "Команда", roles: 3 }, ctx);
    expect(r.ok).toBe(false);
  });

  test("roles вовсе нет — по-прежнему легально (канал только с оркестратором)", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL", { title: "Команда" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.roles).toEqual([]);
  });

  test("нормальный массив ролей проходит", () => {
    const r = buildPayload("CREATE_TEAM_CHANNEL", { title: "Команда", roles: ["smm", "design"] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.roles).toEqual(["smm", "design"]);
  });
});

describe("LIST_RECENT_MESSAGES: неизвестные kinds — отказ, не подмена дефолтом", () => {
  test("список целиком из неизвестных значений отвергается", () => {
    const r = buildPayload("LIST_RECENT_MESSAGES", { chat_id: 1, kinds: ["user", "agent"] }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("user");
      expect(r.error).toContain("agent");
    }
  });

  test("одно неизвестное значение среди валидных тоже отвергается, а не выбрасывается молча", () => {
    const r = buildPayload("LIST_RECENT_MESSAGES", { chat_id: 1, kinds: ["text", "bot"] }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bot");
  });

  test("валидные kinds доезжают без изменений", () => {
    const r = buildPayload("LIST_RECENT_MESSAGES", { chat_id: 1, kinds: ["text", "service"] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.kinds).toEqual(["text", "service"]);
  });

  test("kinds не задан — undefined, дефолт ниже по стеку остаётся в силе", () => {
    const r = buildPayload("LIST_RECENT_MESSAGES", { chat_id: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.kinds).toBeUndefined();
  });
});

describe("PUBLISH_TO_CHANNEL: поля обложки — отказ вместо тихой обрезки", () => {
  const base = { channelId: -100123, text: "пост" };

  test("coverTitle длиннее 160 отвергается с указанием длины и лимита", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { ...base, coverTitle: "я".repeat(190) }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("coverTitle");
      expect(r.error).toContain("190");
      expect(r.error).toContain("160");
    }
  });

  test("coverSubtitle длиннее 160 отвергается", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { ...base, coverSubtitle: "с".repeat(161) }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("coverSubtitle");
  });

  test("coverPrompt длиннее 4000 отвергается", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { ...base, coverPrompt: "п".repeat(4001) }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("coverPrompt");
  });

  test("ровно на границе — проходит целиком, без потери символов", () => {
    const title = "т".repeat(160);
    const prompt = "п".repeat(4000);
    const r = buildPayload("PUBLISH_TO_CHANNEL", { ...base, coverTitle: title, coverPrompt: prompt }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.coverTitle).toBe(title);
      expect(r.payload.coverPrompt).toBe(prompt);
    }
  });

  test("пустая строка и не-строка — это «поля нет», а не ошибка", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { ...base, coverTitle: "   ", coverSubtitle: 42 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.coverTitle).toBeUndefined();
      expect(r.payload.coverSubtitle).toBeUndefined();
    }
  });
});
