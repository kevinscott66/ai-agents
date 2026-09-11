/**
 * Аудит 2026-09-11, круг 38: подписи к полномочиям и к резчику текста.
 *
 * Шесть мест, где комментарий описывал не тот код, который под ним стоит, и
 * одно, где от этого страдало поведение. Общее у них — все они про то, кому
 * что позволено, и все читаются ровно тем, кто собирается это менять.
 *
 * 1. `redactText` (lib/log.ts) — ЕДИНСТВЕННАЯ поведенческая правка круга.
 *    Порог был 7, подпись обещала «never reveals middle content, regardless of
 *    length». При длине 8 середины нет вовсе: `first4 + last4` — вся строка.
 *    Замер до правки: `"12345678"` → `<len=8 first4=1234 last4=5678>`,
 *    `"7 Baker St"` → `<len=10 first4=7 Ba last4=r St>`. В эту полосу попадают
 *    одноразовый код, короткий пароль, адрес — а MTProto-сессия без privacy
 *    mode видит все сообщения чата, и `log.info` в проде включён по умолчанию.
 *    Сторожа полосу 8–11 не проверял ни один: они берут 20, 39, 58 символов и
 *    `"да"`.
 *
 * 2. `floodCooldownUntil` (lib/userbot-flood.ts) — докблок говорил «ключ —
 *    characterId» и добавлял «лучше недоблокировать чужую роль, чем глушить
 *    одиннадцать аккаунтов из-за одного». Все три аксессора карты ключуются
 *    `userbotAccountKey`. Это не просто неправда: абзац читается как
 *    незакрытый TODO и приглашает сузить ключ обратно — то есть откатить
 *    аудит 2026-09-11, который свёл вёдра и кулдаун на аккаунт именно потому,
 *    что FLOOD_WAIT выдаётся аккаунту.
 *
 * 3. `checkUserbotFloodLimit` (lib/rate-limits.ts) — та же копия того же
 *    правила: «per-(characterId, chatId)» в подписи и `per character/chat` в
 *    тексте отказа, при ключе через `userbotAccountKey`.
 *
 * 4. `via_userbot` (lib/action-payload.ts) — правило «только оркестратор +
 *    человек обязателен» записано в одном поле из трёх, и там слабее, чем оно
 *    есть: «requires approval in semi_auto mode». `payloadForcesApproval`
 *    взводит `forceApproval`, а `evaluateGate` проверяет его ДО ветвлений по
 *    режиму — значит и в `auto`. У `SET_REACTION` и `DELETE_MESSAGE` про
 *    подтверждение не было сказано ничего.
 *
 * 5. `MODEL_FORBIDDEN_PAYLOAD_FIELDS` (lib/self-diag.ts) — докблок приглашал
 *    «следующему есть куда лечь», а единственный потребитель ходит по
 *    результату `contextFieldsOf`, оставляющему только `_`-ключи. Имя без
 *    префикса дало бы предупреждение, которое не сработает никогда, и `delete`
 *    по отсутствующему ключу.
 *
 * 6. Шапка `db-maint.ts` называла две таблицы из четырёх — и «невидимыми»
 *    оказались те, где лежит самое чувствительное.
 *
 * 7. `handoff.ts` объяснял дедуп механизмом `OR IGNORE`, снятым аудитом
 *    2026-08-12 (он съедал расшифровки голосовых).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { redactText } from "../lib/log.ts";
import {
  evaluateGate,
  payloadForcesApproval,
  setAutonomy,
  setPermission,
  USERBOT_FORCE_APPROVAL,
} from "../lib/permissions.ts";
import {
  checkUserbotFloodLimit,
  commitUserbotFloodLimit,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import {
  noteFloodWait,
  floodCooldownRemainingMs,
  _resetFloodCooldowns,
} from "../lib/userbot-flood.ts";
import {
  MODEL_FORBIDDEN_PAYLOAD_FIELDS,
  TRUSTED_ONLY_PAYLOAD_FIELDS,
} from "../lib/self-diag.ts";
import { db } from "../lib/db.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");

/**
 * Цитата исправленного текста в комментарии — не возврат текста.
 * Как и в audit-2026-08-27, цитата берётся в бэктики, а проверка «этой фразы
 * в файле больше нет» снимает забэкренные куски перед поиском. Иначе сторож
 * запрещал бы объяснять, что именно чинили.
 */
const noQuotes = (s: string) => s.replace(/`[^`]*`/g, "``");

describe("redactText: отпечаток только при реально скрытой середине", () => {
  test("полоса 8–11 больше не отдаёт содержимое", () => {
    for (const s of ["12345678", "пароль12", "123456789", "7 Baker St", "1Password1"]) {
      const out = redactText(s);
      expect(out).toBe(`<len=${s.length}>`);
      expect(out).not.toContain(s.slice(0, 4));
      expect(out).not.toContain(s.slice(-4));
    }
  });

  test("на длине 8 отпечаток совпадал со всей строкой — этого больше нет", () => {
    // Прежнее поведение: <len=8 first4=1234 last4=5678>.
    expect(redactText("12345678")).not.toContain("first4");
    expect(redactText("12345678")).not.toContain("5678");
  });

  test("длинный текст по-прежнему опознаётся по отпечатку", () => {
    const s = "Здравствуйте, это довольно длинное сообщение про релиз.";
    const out = redactText(s);
    expect(out).toContain(`len=${s.length}`);
    expect(out).toMatch(/^<len=\d+ first4=.{4} last4=.{4}>$/);
  });

  test("скрытых символов всегда не меньше четырёх", () => {
    for (let n = 0; n <= 40; n++) {
      const s = "x".repeat(n);
      const out = redactText(s);
      if (out === `<len=${n}>`) continue;
      const shown = (out.match(/first4=(.{4}) last4=(.{4})/) ?? []).slice(1).join("");
      expect(n - shown.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("граница ровно там, где обещает докстрока", () => {
    expect(redactText("x".repeat(11))).toBe("<len=11>");
    expect(redactText("x".repeat(12))).toMatch(/first4=/);
  });

  test("край и пустота не изменились", () => {
    expect(redactText(null)).toBe("<len=0>");
    expect(redactText(undefined)).toBe("<len=0>");
    expect(redactText("")).toBe("<len=0>");
    expect(redactText("да")).toBe("<len=2>");
  });

  test("порог выведен из длин кусков, а не вписан числом", () => {
    const src = read("lib/log.ts");
    expect(src).toContain("const shown = REDACT_PREFIX + REDACT_SUFFIX;");
    expect(src).toContain("s.length < shown + REDACT_MIN_HIDDEN");
    // Прежнее обещание, выполнявшееся впустую, из файла убрано.
    expect(src).not.toContain("Never reveals middle content");
  });
});

describe("кулдаун FLOOD_WAIT ключуется аккаунтом — и так и написано", () => {
  const ROUTER_KEY = "USERBOT_ROUTER_ENABLED";
  const savedRouter = process.env[ROUTER_KEY];

  beforeEach(() => {
    delete process.env[ROUTER_KEY]; // роутер выключен — все на синглтоне владельца
    _resetRateLimits();
    _resetFloodCooldowns();
  });

  afterAll(() => {
    if (savedRouter === undefined) delete process.env[ROUTER_KEY];
    else process.env[ROUTER_KEY] = savedRouter;
    _resetRateLimits();
    _resetFloodCooldowns();
  });

  test("бан, пойманный одной ролью, молчит и для остальных", () => {
    const now = Date.now();
    noteFloodWait("smm", 30, now);
    for (const role of ["smm", "design", "copy", "orchestrator"]) {
      expect(floodCooldownRemainingMs(role, now)).toBeGreaterThan(0);
    }
  });

  test("докблок не зовёт сузить ключ обратно до роли", () => {
    const src = read("lib/userbot-flood.ts");
    expect(src).toContain("Ключ — АККАУНТ (`userbotAccountKey`), а не роль");
    expect(src).not.toContain("Ключ — characterId, как и у ведра");
    // Приглашение к откату: фраза жила только в утверждающем абзаце.
    const doc = src.slice(0, src.indexOf("const floodCooldownUntil"));
    expect(doc).not.toContain("лучше недоблокировать чужую роль, чем глушить");
  });

  test("все три аксессора карты ключуются одной функцией", () => {
    const src = read("lib/userbot-flood.ts");
    expect(src.match(/const key = userbotAccountKey\(characterId\);/g) ?? []).toHaveLength(3);
  });

  test("ведро общее: слот, съеденный одной ролью, закрывает вторую", () => {
    const savedMax = process.env.USERBOT_FLOOD_MAX_PER_WINDOW;
    try {
      process.env.USERBOT_FLOOD_MAX_PER_WINDOW = "1";
      _resetRateLimits();
      const chat = -1_002_777_912;
      const now = Date.now();
      expect(checkUserbotFloodLimit("smm", chat, now).ok).toBe(true);
      commitUserbotFloodLimit("smm", chat, now);
      // Роль другая — аккаунт тот же, значит ведро то же.
      const second = checkUserbotFloodLimit("design", chat, now);
      expect(second.ok).toBe(false);
      expect(second.reason).toContain("per account/chat");
      expect(second.reason).not.toContain("per character/chat");
    } finally {
      if (savedMax === undefined) delete process.env.USERBOT_FLOOD_MAX_PER_WINDOW;
      else process.env.USERBOT_FLOOD_MAX_PER_WINDOW = savedMax;
      _resetRateLimits();
    }
  });

  test("подпись ведра не обещает ролевую гранулярность", () => {
    const src = read("lib/rate-limits.ts");
    expect(src).not.toContain("Check per-(characterId, chatId) userbot flood limit");
    expect(src).toContain("на пару (АККАУНТ, chatId)");
  });
});

describe("голос владельца: человек обязателен в любом режиме", () => {
  const TARGET = "_test_owner_voice_docs";
  let savedAutonomy = saveAutonomy();

  beforeEach(() => {
    savedAutonomy = saveAutonomy();
    setAutonomy("global", "*", "auto");
    for (const a of USERBOT_FORCE_APPROVAL) {
      setPermission(TARGET, a, { allowed: true, requires_approval: false });
    }
  });

  afterEach(() => {
    restoreAutonomy(savedAutonomy);
    db.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(TARGET);
  });

  test("в режиме auto все три действия требуют подтверждения", () => {
    for (const actionType of USERBOT_FORCE_APPROVAL) {
      const reason = payloadForcesApproval(actionType, { via_userbot: true });
      expect(reason).not.toBeNull();
      const r = evaluateGate({
        agentKey: TARGET,
        actionType,
        forceApproval: true,
        forceApprovalReason: reason ?? undefined,
      });
      expect(r.decision).toBe("approval");
    }
  });

  test("без флага те же действия в auto проходят без человека", () => {
    for (const actionType of USERBOT_FORCE_APPROVAL) {
      expect(payloadForcesApproval(actionType, {})).toBeNull();
    }
  });

  test("подписи всех трёх полей называют правило целиком", () => {
    const src = read("lib/action-payload.ts");
    // Прежняя, более слабая формулировка — ровно в том поле, ради которого
    // инвариант чинили дважды. В файле она осталась только как цитата в
    // бэктиках внутри разбора; действующей формулировкой быть перестала.
    expect(noQuotes(src)).not.toContain("approval in semi_auto mode");
    expect(src).toContain("«`requires approval in semi_auto mode`»");
    expect(src).toContain("Подтверждение человека обязательно В ЛЮБОМ");
    // Правило названо у каждого из трёх полей, а не у одного.
    expect(src.match(/USERBOT_FORCE_APPROVAL/g) ?? []).toHaveLength(3);
    expect(src.match(/Голос владельца: только оркестратор/g) ?? []).toHaveLength(2);
  });

  test("источник правды — набор в permissions.ts, и он из трёх действий", () => {
    expect([...USERBOT_FORCE_APPROVAL].sort()).toEqual([
      "DELETE_MESSAGE",
      "SEND_MESSAGE",
      "SET_REACTION",
    ]);
  });
});

describe("MODEL_FORBIDDEN_PAYLOAD_FIELDS: контракт назван вслух", () => {
  test("в списке только имена с `_`-префиксом", () => {
    // Имя без префикса — молчаливый no-op: потребитель ходит по contextFieldsOf.
    for (const f of MODEL_FORBIDDEN_PAYLOAD_FIELDS) expect(f.startsWith("_")).toBe(true);
  });

  test("докблок называет ограничение и адрес для поля без префикса", () => {
    const src = read("lib/self-diag.ts");
    expect(src).toContain("верно ТОЛЬКО для\n * имени с `_`-префиксом");
    expect(src).toContain("`TRUSTED_ONLY_PAYLOAD_FIELDS`");
  });

  test("названный адрес существует и содержит поля без префикса", () => {
    const noPrefix = TRUSTED_ONLY_PAYLOAD_FIELDS.filter((f) => !f.startsWith("_"));
    expect(noPrefix).toEqual(["createdBy", "inputPayload"]);
  });

  test("contextFieldsOf действительно фильтрует по префиксу", () => {
    const src = read("lib/self-diag.ts");
    expect(src).toContain('if (k.startsWith("_")) out[k] = v;');
  });
});

describe("шапки, разошедшиеся с кодом", () => {
  test("db-maint называет все четыре архивируемые таблицы", () => {
    const src = read("lib/db-maint.ts");
    const header = src.slice(0, src.indexOf("*/"));
    for (const t of ["agent_actions", "audit_logs", "approvals", "role_runtime_queue"]) {
      expect(header).toContain(t);
    }
  });

  test("список в шапке совпадает с полями ArchiveResult", () => {
    const src = read("lib/db-maint.ts");
    const iface = src.slice(
      src.indexOf("export interface ArchiveResult {"),
      src.indexOf("cutoff_ms: number;"),
    );
    const fields = [...iface.matchAll(/^\s{2}(\w+): number;$/gm)].map((m) => m[1]!);
    expect(fields.sort()).toEqual([
      "agent_actions",
      "approvals",
      "audit_logs",
      "role_runtime_queue",
    ]);
    const header = src.slice(0, src.indexOf("*/"));
    for (const f of fields) expect(header).toContain(f);
  });

  test("handoff не обещает OR IGNORE — его сняли в 2026-08-12", () => {
    const handoff = read("lib/handoff.ts");
    expect(noQuotes(handoff)).not.toContain("OR IGNORE");
    expect(handoff).toContain("`ON CONFLICT ... DO UPDATE`");
    const memory = read("lib/memory.ts");
    expect(memory).toContain("ON CONFLICT(chat_id, tg_message_id)");
    expect(memory).not.toContain("INSERT OR IGNORE INTO messages");
  });

  test("loadUserbotTextParser: откат описан для обоих вызывающих", () => {
    const src = read("lib/userbot.ts");
    const doc = src.slice(
      src.indexOf(" * Разбор markdown ровно тем парсером"),
      src.indexOf("export async function loadUserbotTextParser"),
    );
    expect(doc).toContain("`userbotPartFits`");
    expect(doc).toContain("`markSelfSend`");
    expect(doc).not.toContain("Вызывающий останется на сырой длине");
    // Вызывающих по-прежнему ровно два, иначе абзац снова неполон
    // (считаем вызовы, а не объявление).
    const dispatch = read("lib/dispatch/telegram.ts");
    const calls = /await loadUserbotTextParser\(\)/g;
    expect((src.match(calls) ?? []).length).toBe(1);
    expect((dispatch.match(calls) ?? []).length).toBe(1);
  });
});
