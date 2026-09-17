/**
 * DNS-записи в Cloudflare (CLOUDFLARE_DNS) — шаг 8 плана владельца.
 *
 * Модуль без побочек: разбор ввода модели, строгий повторный разбор перед
 * вызовом API и строка для карточки подтверждения — одна функция на всех,
 * чтобы владелец одобрял ровно то, что уйдёт в Cloudflare.
 *
 * Сознательно узко:
 *  - зоны — только из CLOUDFLARE_DNS_ZONES (`имя=id`, id — 32 hex). Токен
 *    владелец выпускает с одним правом «Zone → DNS → Edit» на эти зоны, без
 *    Zone Read: id зоны берём из env, а не ищем по API;
 *  - типы A, AAAA, CNAME, TXT. NS, MX, CAA и прочие меняют владение доменом,
 *    почту и выпуск сертификатов — их здесь нет вовсе;
 *  - корень зоны, `*` и имена из CLOUDFLARE_DNS_PROTECTED не трогаются: на
 *    них сидят сам агент и почта, и «поменяй A-запись» не должно их уронить;
 *  - update и delete несут `previous` — содержимое, которое модель видела в
 *    CLOUDFLARE_DNS_LIST. Карточка показывает «было → станет», а хендлер
 *    меняет запись, только если она всё ещё такая (сравнение-и-замена).
 *
 * Подтверждение обязательно при любой автономии — категория `dns`
 * в lib/approval-policy.ts.
 */
import { isIPv4, isIPv6 } from "node:net";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
export const DNS_OPS = ["create", "update", "delete"] as const;
export type DnsOp = (typeof DNS_OPS)[number];

export const DNS_TXT_MAX = 2048;
export const DNS_TTL_AUTO = 1;
const TTL_MIN = 60;
const TTL_MAX = 86_400;
const ZONE_ID = /^[0-9a-f]{32}$/;
// Метка хоста; ведущее подчёркивание — для служебных TXT (_dmarc, _acme-challenge).
const LABEL = /^_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface DnsChange {
  op: DnsOp;
  zone: string;
  name: string;
  type: DnsRecordType;
  /** Новое содержимое: create и update. */
  content?: string;
  /** Текущее содержимое: update и delete. */
  previous?: string;
  ttl: number;
  proxied: boolean;
}

/** «example.com=<32 hex>,…» → имя зоны → id. Кривые пары пропускаются. */
export function parseDnsZones(raw: string | undefined): Map<string, string> {
  const zones = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const [name, id] = pair.split("=").map((s) => s?.trim().toLowerCase());
    const zone = normalizeHost(name);
    if (zone && zone.includes(".") && id && ZONE_ID.test(id)) zones.set(zone, id);
  }
  return zones;
}

export function parseDnsProtected(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map(normalizeHost).filter((h): h is string => h !== null));
}

/** Имя хоста в нижнем регистре без точки в конце; null — не имя хоста. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.length > 253) return null;
  return s.split(".").every((l) => LABEL.test(l)) ? s : null;
}

/** Самая длинная зона из списка, внутри которой лежит имя. */
export function zoneFor(name: string, zones: ReadonlyMap<string, string>): string | null {
  let best: string | null = null;
  for (const zone of zones.keys()) {
    if ((name === zone || name.endsWith(`.${zone}`)) && (!best || zone.length > best.length)) best = zone;
  }
  return best;
}

/** Почему это имя трогать нельзя; null — можно. */
export function dnsNameRefusal(name: string, zone: string, protectedNames: ReadonlySet<string>): string | null {
  if (name === zone) return `корень зоны ${zone} не меняется через агента`;
  if (protectedNames.has(name)) return `${name} в CLOUDFLARE_DNS_PROTECTED`;
  return null;
}

export function dnsContentError(type: DnsRecordType, content: unknown, name?: string): string | null {
  if (typeof content !== "string" || !content) return "content is required";
  switch (type) {
    case "A":
      return isIPv4(content) ? null : "A: content must be an IPv4 address";
    case "AAAA":
      return isIPv6(content) ? null : "AAAA: content must be an IPv6 address";
    case "CNAME": {
      const target = normalizeHost(content);
      if (!target || target !== content || !target.includes(".")) return "CNAME: content must be a lowercase hostname";
      return target === name ? "CNAME: target equals the record name" : null;
    }
    case "TXT":
      if (content.length > DNS_TXT_MAX) return `TXT: at most ${DNS_TXT_MAX} chars`;
      // Только печатный ASCII: карточка должна читаться так же, как уйдёт.
      return /^[\x20-\x7e]+$/.test(content) ? null : "TXT: printable ASCII only";
  }
}

const isType = (v: unknown): v is DnsRecordType => (DNS_RECORD_TYPES as readonly unknown[]).includes(v);
const isOp = (v: unknown): v is DnsOp => (DNS_OPS as readonly unknown[]).includes(v);
const validTtl = (v: unknown): v is number =>
  v === DNS_TTL_AUTO || (Number.isInteger(v) && (v as number) >= TTL_MIN && (v as number) <= TTL_MAX);

/**
 * Ввод модели → нормализованная заявка. Зона выводится из имени и списка зон,
 * поэтому модель не может назвать зону, которой нет в env.
 */
export function buildDnsChange(
  input: Record<string, unknown>,
  zones: ReadonlyMap<string, string>,
  protectedNames: ReadonlySet<string>,
): { ok: true; change: DnsChange } | { ok: false; error: string } {
  const op = input.op;
  if (!isOp(op)) return { ok: false, error: `op must be one of ${DNS_OPS.join(", ")}` };
  const type = typeof input.type === "string" ? input.type.toUpperCase() : input.type;
  if (!isType(type)) return { ok: false, error: `type must be one of ${DNS_RECORD_TYPES.join(", ")}` };
  const name = normalizeHost(input.name);
  if (!name) return { ok: false, error: "name must be a full hostname, e.g. api.example.com (no wildcard)" };
  if (zones.size === 0) return { ok: false, error: "CLOUDFLARE_DNS_ZONES is empty" };
  const zone = zoneFor(name, zones);
  if (!zone) return { ok: false, error: `${name} is outside the allowed zones: ${[...zones.keys()].join(", ")}` };
  const refusal = dnsNameRefusal(name, zone, protectedNames);
  if (refusal) return { ok: false, error: refusal };

  const change: DnsChange = { op, zone, name, type, ttl: DNS_TTL_AUTO, proxied: false };
  if (op !== "delete") {
    const content = type === "CNAME" && typeof input.content === "string" ? normalizeHost(input.content) ?? input.content : input.content;
    const err = dnsContentError(type, content, name);
    if (err) return { ok: false, error: err };
    change.content = content as string;
    const ttl = input.ttl ?? DNS_TTL_AUTO;
    if (!validTtl(ttl)) return { ok: false, error: `ttl must be 1 (auto) or ${TTL_MIN}..${TTL_MAX}` };
    change.ttl = ttl;
    const proxied = input.proxied ?? false;
    if (typeof proxied !== "boolean") return { ok: false, error: "proxied must be boolean" };
    if (proxied && type === "TXT") return { ok: false, error: "TXT records cannot be proxied" };
    change.proxied = proxied;
  }
  if (op !== "create") {
    const previous = type === "CNAME" && typeof input.previous === "string" ? normalizeHost(input.previous) ?? input.previous : input.previous;
    if (dnsContentError(type, previous)) {
      return { ok: false, error: "previous is required: current content of the record, from CLOUDFLARE_DNS_LIST" };
    }
    change.previous = previous as string;
  }
  if (op === "update" && change.previous === change.content) {
    return { ok: false, error: "content equals previous: nothing to change" };
  }
  return { ok: true, change };
}

/**
 * Строгий повторный разбор: хендлер и карточка работают только с тем, что
 * мог собрать buildDnsChange. Лишние поля, кроме служебных, — отказ.
 */
export function parseDnsChange(raw: unknown): DnsChange | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = Object.keys(m).filter((k) => k !== "_userId" && k !== "_delegated").sort().join(",");
  const expected: Record<DnsOp, string> = {
    create: "content,name,op,proxied,ttl,type,zone",
    update: "content,name,op,previous,proxied,ttl,type,zone",
    delete: "name,op,previous,proxied,ttl,type,zone",
  };
  if (!isOp(m.op) || keys !== expected[m.op] || !isType(m.type)) return null;
  const name = normalizeHost(m.name);
  const zone = normalizeHost(m.zone);
  if (!name || name !== m.name || !zone || zone !== m.zone || !(name.endsWith(`.${zone}`))) return null;
  if (!validTtl(m.ttl) || typeof m.proxied !== "boolean" || (m.proxied && m.type === "TXT")) return null;
  if (m.op !== "delete" && dnsContentError(m.type, m.content, name)) return null;
  if (m.op !== "create" && dnsContentError(m.type, m.previous)) return null;
  if (m.op === "delete" && (m.ttl !== DNS_TTL_AUTO || m.proxied)) return null;
  if (m.op === "update" && m.previous === m.content) return null;
  return m as unknown as DnsChange;
}

function settings(c: DnsChange): string {
  const ttl = c.ttl === DNS_TTL_AUTO ? "auto" : `${c.ttl}s`;
  return c.type === "TXT" ? `ttl ${ttl}` : `ttl ${ttl}, proxy ${c.proxied ? "on" : "off"}`;
}

/** Карточка подтверждения: что, где, было → станет. */
export function describeDnsChange(c: DnsChange): string {
  switch (c.op) {
    case "create":
      return `DNS ${c.zone}: создать ${c.type} ${c.name} → ${c.content} (${settings(c)})`;
    case "update":
      return `DNS ${c.zone}: изменить ${c.type} ${c.name}: ${c.previous} → ${c.content} (${settings(c)})`;
    case "delete":
      return `DNS ${c.zone}: УДАЛИТЬ ${c.type} ${c.name} (сейчас ${c.previous})`;
  }
}
