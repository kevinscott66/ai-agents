/**
 * Круг 32: откат чужой отправки уносил чужую роль.
 *
 * `markSelfSend` кладёт в реестр `{exp, agentKey}`, `consumeSelfSendMeta`
 * забирает записи с НАЧАЛА (`shift`), а `unmarkSelfSend` снимал их с КОНЦА
 * (`pop`) — с объяснением «записи внутри ключа взаимозаменяемы (это просто
 * сроки годности)». Взаимозаменяемыми они перестали быть в том же файле
 * 2026-08-28, когда рядом со сроком появился `agentKey`; докблок об этом не
 * узнал.
 *
 * Цена: две роли шлют байт-в-байт одинаковый короткий текст («готово», «ок»)
 * в один чат, отправка первой падает — откат уносит запись ВТОРОЙ, а её эхо
 * забирает атрибуцию первой. `userbot-ingest.ts` пишет эту строку в
 * `messages`, то есть в историю чата, которой кормится следующий ход.
 *
 * Инвариант: откат снимает запись своей роли либо не снимает ничего.
 */
import { describe, test, expect } from "bun:test";
import {
  markSelfSend,
  unmarkSelfSend,
  consumeSelfSendMeta,
  consumeSelfSend,
} from "../lib/userbot-self-sends.ts";

const TEXT = "готово";

describe("откат пометки не ворует чужую роль", () => {
  test("падение backend не переименовывает эхо qa", () => {
    const chat = -100520001;
    markSelfSend(chat, TEXT, "backend");
    markSelfSend(chat, TEXT, "qa");
    unmarkSelfSend(chat, TEXT, "backend");
    expect(consumeSelfSendMeta(chat, TEXT)).toEqual({ agentKey: "qa" });
    expect(consumeSelfSendMeta(chat, TEXT)).toBeNull();
  });

  test("падение второй роли оставляет первую нетронутой", () => {
    const chat = -100520002;
    markSelfSend(chat, TEXT, "backend");
    markSelfSend(chat, TEXT, "qa");
    unmarkSelfSend(chat, TEXT, "qa");
    expect(consumeSelfSendMeta(chat, TEXT)).toEqual({ agentKey: "backend" });
    expect(consumeSelfSendMeta(chat, TEXT)).toBeNull();
  });

  test("две пометки одной роли взаимозаменяемы — снимается одна", () => {
    const chat = -100520003;
    markSelfSend(chat, TEXT, "smm");
    markSelfSend(chat, TEXT, "smm");
    unmarkSelfSend(chat, TEXT, "smm");
    expect(consumeSelfSendMeta(chat, TEXT)).toEqual({ agentKey: "smm" });
    expect(consumeSelfSendMeta(chat, TEXT)).toBeNull();
  });

  test("своей записи уже нет — не снимаем чужую", () => {
    const chat = -100520004;
    markSelfSend(chat, TEXT, "qa");
    // Эхо backend'а пришло раньше отката и забрало его запись... точнее, его
    // записи и не было: откат по роли, которой в реестре нет, — no-op.
    unmarkSelfSend(chat, TEXT, "backend");
    expect(consumeSelfSendMeta(chat, TEXT)).toEqual({ agentKey: "qa" });
  });

  test("публикация в канал (роли нет) откатывается как прежде", () => {
    const chat = -100520005;
    markSelfSend(chat, "пост в канал");
    unmarkSelfSend(chat, "пост в канал");
    expect(consumeSelfSend(chat, "пост в канал")).toBe(false);
  });

  test("роль-отправитель и публикация в канал не путаются", () => {
    const chat = -100520006;
    markSelfSend(chat, TEXT, null);
    markSelfSend(chat, TEXT, "smm");
    unmarkSelfSend(chat, TEXT);
    expect(consumeSelfSendMeta(chat, TEXT)).toEqual({ agentKey: "smm" });
    expect(consumeSelfSendMeta(chat, TEXT)).toBeNull();
  });
});
