/**
 * Одноразовые короткоживущие билеты на SSE-подключение (аудит 2026-08-04).
 *
 * Зачем. `EventSource` не умеет заголовки, поэтому Mini App открывал поток как
 * `/api/events?initData=<...>` — то есть отправлял полноценный credential в
 * query-строке. initData валиден сутки (`verifyInitData`, maxAgeSec=86400) и
 * принимается ВСЕМИ ручками /api/*, а query-строка оседает в access-логе nginx,
 * в Referer у любой внешней картинки и в истории прокси. Одна строчка лога =
 * полная имперсонация пользователя на сутки.
 *
 * Как теперь. Клиент просит билет обычным POST'ом (initData едет заголовком),
 * получает случайный 256-битный токен и открывает поток как
 * `/api/events?ticket=<...>`. Билет живёт 30 секунд, гасится при первом
 * предъявлении и не даёт доступа ни к чему, кроме открытия потока. В логе
 * оседает уже мусор: к моменту, когда его оттуда достанут, он мёртв дважды.
 *
 * Хранилище — в памяти процесса. Это осознанно: билет живёт меньше, чем
 * занимает рестарт, а переживать рестарт ему незачем — клиент просто запросит
 * новый (SSE и так переподключается с бэкоффом).
 */
import { randomBytes } from "node:crypto";

/** Сколько живёт билет. Хватает на «POST → открыть EventSource». */
export const TICKET_TTL_MS = 30_000;

/**
 * Потолок на хранилище. Билет выдаётся только аутентифицированному
 * пользователю и под POST-рейт-лимитом, так что раздуть карту до OOM нельзя;
 * потолок — страховка от чужой ошибки (клиент в цикле переподключения), а не
 * от атаки. Вытесняем самые старые: Map хранит порядок вставки, а TTL общий,
 * поэтому порядок вставки == порядок протухания.
 */
const MAX_TICKETS = 1000;

interface Ticket {
  userId: number;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

function prune(now: number): void {
  for (const [token, t] of tickets) {
    if (t.expiresAt > now) break; // дальше только более свежие
    tickets.delete(token);
  }
}

/** Выдать одноразовый билет пользователю. Возвращает токен и TTL в секундах. */
export function issueSseTicket(
  userId: number,
  now: number = Date.now(),
): { ticket: string; expiresInSec: number } {
  prune(now);
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
  // base64url: попадает в query без экранирования, 32 байта энтропии —
  // перебор за 30 секунд не обсуждается.
  const token = randomBytes(32).toString("base64url");
  tickets.set(token, { userId, expiresAt: now + TICKET_TTL_MS });
  return { ticket: token, expiresInSec: Math.floor(TICKET_TTL_MS / 1000) };
}

/**
 * Погасить билет. Возвращает id пользователя либо null, если билета нет, он
 * протух или уже был предъявлен. Гасится ДО проверки срока — предъявленный
 * билет не должен пережить неудачную попытку.
 */
export function redeemSseTicket(
  token: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!token) return null;
  const t = tickets.get(token);
  if (!t) return null;
  tickets.delete(token);
  if (t.expiresAt <= now) return null;
  return t.userId;
}

/** Только для тестов: очистить хранилище. */
export function _resetSseTickets(): void {
  tickets.clear();
}

/** Только для тестов/диагностики: сколько билетов сейчас в памяти. */
export function _sseTicketCount(): number {
  return tickets.size;
}
