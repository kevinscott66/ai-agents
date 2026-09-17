/**
 * Гейт платных действий: выполняется только то, что владелец подписал ключом
 * из Secure Enclave телефона. Спецификация — docs/signed-actions.md.
 *
 * Модуль не знает, что именно покупается: исполнитель (например, заказ такси)
 * вызывает claim → checkFinal → complete и выполняет ровно подписанные params.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "./time-constants.ts";

export type SignedActionError =
  | "key_invalid" | "key_unknown" | "key_not_pending" | "code_invalid" | "code_expired" | "code_attempts"
  | "no_active_key" | "payload_invalid" | "limit_amount" | "limit_daily"
  | "nonce_unknown" | "nonce_used" | "expired" | "key_revoked" | "signature_invalid"
  | "payload_mismatch" | "price_deviation" | "registration_limit";

export class SignedActionRefusal extends Error {
  constructor(readonly code: SignedActionError) { super(code); }
}

export interface SignedActionLimits {
  maxRub: number;
  dailyMax: number;
  deviationPct: number;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CODE_TTL_MS = 10 * MINUTE_MS;
const CODE_ATTEMPTS = 5;
/** Каждая регистрация шлёт владельцу сообщение с кодом — ограничиваем, чтобы не заспамить. */
const REGISTRATIONS_PER_HOUR = 3;
const APPROVE_TTL_MS = 2 * MINUTE_MS;
const CLAIM_WINDOW_MS = 5 * MINUTE_MS;
/** Статусы, которые расходуют дневной лимит: деньги могли уйти. */
const SPENDING = ["approved", "executing", "executed", "failed"];

const refuse = (code: SignedActionError): never => { throw new SignedActionRefusal(code); };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): SignedActionLimits {
  return {
    maxRub: positiveInt(env.PAID_ACTION_MAX_RUB, 1000, "PAID_ACTION_MAX_RUB"),
    dailyMax: positiveInt(env.PAID_ACTION_DAILY_MAX, 5, "PAID_ACTION_DAILY_MAX"),
    deviationPct: positiveInt(env.PAID_ACTION_PRICE_DEVIATION_PCT, 15, "PAID_ACTION_PRICE_DEVIATION_PCT"),
  };
}

/** Канонический JSON: отсортированные ключи, без пробелов, только целые числа. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new SignedActionRefusal("payload_invalid");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new SignedActionRefusal("payload_invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${canonicalJson(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return refuse("payload_invalid");
}

/** Строгий base64: только канонический вид, иначе одна подпись имела бы много записей. */
function strictBase64(value: unknown, expectedBytes?: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || !value.length || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return null;
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) return null;
  return new Uint8Array(bytes);
}

/** Сутки по Москве: Краснодар в том же поясе, лимит «в день» считается по ним. */
function moscowDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date(now));
}

async function importKey(spki: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

interface ActionRow {
  nonce: string;
  key_id: string;
  payload: string;
  status: string;
  max_final_rub: number;
  expires: number;
  approved: number | null;
}

export class SignedActions {
  constructor(readonly db: Database, readonly limits: SignedActionLimits = limitsFromEnv()) {
    db.run(`CREATE TABLE IF NOT EXISTS signed_action_keys(id TEXT PRIMARY KEY, device TEXT NOT NULL, spki TEXT NOT NULL,
        status TEXT NOT NULL, code_hash TEXT, code_expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, activated INTEGER, revoked INTEGER);
      CREATE TABLE IF NOT EXISTS signed_actions(nonce TEXT PRIMARY KEY, key_id TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, amount_rub INTEGER NOT NULL, max_final_rub INTEGER NOT NULL, day TEXT,
        issued INTEGER NOT NULL, expires INTEGER NOT NULL, approved INTEGER, finished INTEGER);
      CREATE INDEX IF NOT EXISTS signed_actions_day ON signed_actions(day, status);`);
    // Процесс упал посреди выполнения: результат неизвестен, повторять нельзя.
    db.query("UPDATE signed_actions SET status='failed', finished=? WHERE status='executing'").run(Date.now());
  }

  /** Регистрирует открытый ключ телефона. Код активации отправляется владельцу по другому каналу. */
  async registerKey(device: string, spkiBase64: string, now = Date.now()): Promise<{ keyId: string; code: string }> {
    const spki = strictBase64(spkiBase64);
    if (!spki || spki.length > 512 || !device.trim()) return refuse("key_invalid");
    try { await importKey(spki); } catch { return refuse("key_invalid"); }
    const recent = (this.db.query("SELECT COUNT(*) AS n FROM signed_action_keys WHERE created>?").get(now - HOUR_MS) as { n: number }).n;
    if (recent >= REGISTRATIONS_PER_HOUR) return refuse("registration_limit");
    const keyId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.db.query("INSERT INTO signed_action_keys(id,device,spki,status,code_hash,code_expires,created) VALUES(?,?,?,'pending',?,?,?)")
      .run(keyId, device, spkiBase64, sha256(`${keyId}:${code}`), now + CODE_TTL_MS, now);
    return { keyId, code };
  }

  /** Активирует ключ по коду; прежний активный ключ отзывается. */
  activateKey(keyId: string, code: string, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.db.query("SELECT status, code_hash, code_expires, attempts FROM signed_action_keys WHERE id=?")
        .get(keyId) as { status: string; code_hash: string | null; code_expires: number | null; attempts: number } | null;
      if (!row) return refuse("key_unknown");
      if (row.status !== "pending" || !row.code_hash || row.code_expires === null) return refuse("key_not_pending");
      if (row.attempts >= CODE_ATTEMPTS) return refuse("code_attempts");
      if (now > row.code_expires) return refuse("code_expired");
      const expected = Buffer.from(row.code_hash, "hex"), actual = Buffer.from(sha256(`${keyId}:${code}`), "hex");
      if (!timingSafeEqual(expected, actual)) {
        this.db.query("UPDATE signed_action_keys SET attempts=attempts+1 WHERE id=?").run(keyId);
        return;
      }
      this.db.query("UPDATE signed_action_keys SET status='revoked', revoked=? WHERE status='active'").run(now);
      this.db.query("UPDATE signed_action_keys SET status='active', activated=?, code_hash=NULL, code_expires=NULL WHERE id=?").run(now, keyId);
    })();
    // Неверный код фиксируется вне отката транзакции, поэтому ошибка — после неё.
    const status = (this.db.query("SELECT status FROM signed_action_keys WHERE id=?").get(keyId) as { status: string }).status;
    if (status !== "active") refuse("code_invalid");
  }

  activeKey(): { id: string; device: string; activated: number } | null {
    return this.db.query("SELECT id, device, activated FROM signed_action_keys WHERE status='active'").get() as { id: string; device: string; activated: number } | null;
  }

  revokeKey(keyId: string, now = Date.now()): void {
    this.db.query("UPDATE signed_action_keys SET status='revoked', revoked=?, code_hash=NULL WHERE id=? AND status!='revoked'").run(now, keyId);
  }

  private spentToday(now: number): number {
    const marks = SPENDING.map(() => "?").join(",");
    return (this.db.query(`SELECT COUNT(*) AS n FROM signed_actions WHERE day=? AND status IN (${marks})`)
      .get(moscowDay(now), ...SPENDING) as { n: number }).n;
  }

  /** Фиксирует действие и выдаёт байты, которые телефон покажет и подпишет. */
  issue(input: { service: string; action: string; params: Record<string, Json>; amountRub: number }, now = Date.now()): { nonce: string; payload: string } {
    const key = this.db.query("SELECT id FROM signed_action_keys WHERE status='active'").get() as { id: string } | null;
    if (!key) return refuse("no_active_key");
    const { service, action, params, amountRub } = input;
    if (!/^[a-z0-9_]{1,40}$/.test(service) || !/^[a-z0-9_]{1,40}$/.test(action) || !Number.isSafeInteger(amountRub) || amountRub <= 0) return refuse("payload_invalid");
    if (amountRub > this.limits.maxRub) return refuse("limit_amount");
    if (this.spentToday(now) >= this.limits.dailyMax) return refuse("limit_daily");
    const nonce = randomBytes(32).toString("base64url");
    const maxFinal = Math.floor((amountRub * (100 + this.limits.deviationPct)) / 100);
    const expires = now + APPROVE_TTL_MS;
    const payload = canonicalJson({
      v: 1, kind: "paid_action", service, action, params, amount_rub: amountRub, max_final_rub: maxFinal,
      nonce, key_id: key.id, issued_at: Math.floor(now / SECOND_MS), expires_at: Math.floor(expires / SECOND_MS),
    });
    if (Buffer.byteLength(payload) > 4096) return refuse("payload_invalid");
    this.db.query("INSERT INTO signed_actions(nonce,key_id,payload,status,amount_rub,max_final_rub,issued,expires) VALUES(?,?,?,'issued',?,?,?,?)")
      .run(nonce, key.id, payload, amountRub, maxFinal, now, expires);
    return { nonce, payload };
  }

  private row(nonce: string): ActionRow {
    const row = this.db.query("SELECT nonce,key_id,payload,status,max_final_rub,expires,approved FROM signed_actions WHERE nonce=?").get(nonce) as ActionRow | null;
    return row ?? refuse("nonce_unknown");
  }

  /** Действия, ждущие подписи: телефон показывает карточку по байтам payload. */
  pending(now = Date.now()): { nonce: string; payload: string }[] {
    return this.db.query("SELECT nonce, payload FROM signed_actions WHERE status='issued' AND expires>=? ORDER BY issued LIMIT 20").all(now) as { nonce: string; payload: string }[];
  }

  /** Отказ владельца. Подпись не нужна: отказ ничего не тратит. */
  reject(nonce: string, now = Date.now()): void {
    this.row(nonce);
    const changed = this.db.query("UPDATE signed_actions SET status='rejected', finished=? WHERE nonce=? AND status='issued'").run(now, nonce);
    if (!changed.changes) refuse("nonce_used");
  }

  /** Проверяет подпись владельца над сохранённой копией payload. */
  async approve(nonce: string, signatureBase64: string, now = Date.now()): Promise<void> {
    const action = this.row(nonce);
    if (action.status !== "issued") return refuse("nonce_used");
    if (now > action.expires) return refuse("expired");
    const key = this.db.query("SELECT spki, status FROM signed_action_keys WHERE id=?").get(action.key_id) as { spki: string; status: string } | null;
    if (!key || key.status !== "active") return refuse("key_revoked");
    const signature = strictBase64(signatureBase64, 64);
    const valid = !!signature && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(strictBase64(key.spki)!), signature, new TextEncoder().encode(action.payload));
    if (!valid) {
      this.db.query("UPDATE signed_actions SET status='rejected', finished=? WHERE nonce=? AND status='issued'").run(now, nonce);
      return refuse("signature_invalid");
    }
    // Проверка подписи асинхронная: статус, ключ и лимит перепроверяются атомарно.
    this.db.transaction(() => {
      const current = this.row(nonce);
      if (current.status !== "issued") return refuse("nonce_used");
      const still = this.db.query("SELECT status FROM signed_action_keys WHERE id=?").get(action.key_id) as { status: string } | null;
      if (still?.status !== "active") return refuse("key_revoked");
      if (this.spentToday(now) >= this.limits.dailyMax) return refuse("limit_daily");
      this.db.query("UPDATE signed_actions SET status='approved', approved=?, day=? WHERE nonce=?").run(now, moscowDay(now), nonce);
    })();
  }

  /** Исполнитель забирает действие; его payload должен совпасть с подписанным побайтово. */
  claim(nonce: string, payload: string, now = Date.now()): { service: string; action: string; params: Record<string, Json>; amountRub: number; maxFinalRub: number } {
    return this.db.transaction(() => {
      const action = this.row(nonce);
      if (action.status !== "approved") return refuse("nonce_used");
      if (action.approved === null || now > action.approved + CLAIM_WINDOW_MS) return refuse("expired");
      const signed = Buffer.from(action.payload), offered = Buffer.from(payload);
      if (signed.length !== offered.length || !timingSafeEqual(signed, offered)) return refuse("payload_mismatch");
      this.db.query("UPDATE signed_actions SET status='executing' WHERE nonce=?").run(nonce);
      const parsed = JSON.parse(action.payload);
      return { service: parsed.service, action: parsed.action, params: parsed.params, amountRub: parsed.amount_rub, maxFinalRub: parsed.max_final_rub };
    })();
  }

  /** Последняя сверка перед необратимым шагом. Превышение прерывает действие. */
  checkFinal(nonce: string, finalRub: number, now = Date.now()): void {
    const action = this.row(nonce);
    if (action.status !== "executing") return refuse("nonce_used");
    if (Number.isSafeInteger(finalRub) && finalRub > 0 && finalRub <= action.max_final_rub) return;
    this.db.query("UPDATE signed_actions SET status='aborted', finished=? WHERE nonce=? AND status='executing'").run(now, nonce);
    refuse("price_deviation");
  }

  complete(nonce: string, ok: boolean, now = Date.now()): void {
    const changed = this.db.query("UPDATE signed_actions SET status=?, finished=? WHERE nonce=? AND status='executing'").run(ok ? "executed" : "failed", now, nonce);
    if (!changed.changes) refuse("nonce_used");
  }
}
