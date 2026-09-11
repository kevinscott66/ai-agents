// Shared helpers for action-dispatch handlers — consolidates the verbatim
// duplication that had accumulated across the per-domain handler modules:
// the chat-resolver was copied 5× and the HandlerResult union 4×. T-610.
//
// Аудит 2026-08-28: сам резолвер («взять chat_id из payload, иначе из
// контекста») отсюда удалён. Последним его звал аудит в dispatchAndAudit, и
// это было последнее место в проекте, где адресат мог прийти из payload.
// Оставленный экспорт — приглашение позвать его снова.
import { log } from "../log.ts";

/**
 * Действия, чей целевой чат ПРИНУДИТЕЛЬНО равен чату-источнику. Список нужен
 * не хендлерам (они зовут pinnedChatId напрямую), а тестам: он перечисляет
 * поверхность, на которой пиннинг обязан стоять, и падает, когда новый
 * хендлер её расширил, а пиннинг забыли.
 *
 * Заведён он был для аудита: dispatchAndAudit не знает, какой chatId хендлер
 * использовал на самом деле, и писал в agent_actions чат ИЗ PAYLOAD — то есть
 * при попытке эксфильтрации в логе оставался чат атакующего, а не тот, куда
 * сообщение реально ушло. С 2026-08-28 аудит берёт ctx.chatId для ВСЕХ
 * действий (список описывал лишь половину поверхности), и эта роль у списка
 * отпала.
 *
 * Синхронность с хендлерами держится тестом chat-pinning-invariant.test.ts:
 * он вычитывает вызовы pinnedChatId из ВСЕХ модулей lib/dispatch и сверяет с
 * этим списком. Читать только telegram.ts было недостаточно: GENERATE_IMAGE и
 * GENERATE_SVG_IMAGE живут в media.ts, пиннятся там же — и ровно поэтому
 * отсутствовали здесь, то есть аудит по ним писал чат из payload.
 */
export const CHAT_PINNED_ACTIONS = new Set<string>([
  "SEND_MESSAGE",
  "SEND_PHOTO",
  "SEND_DOCUMENT",
  "FORWARD_MESSAGE",
  "SET_REACTION",
  "EDIT_MESSAGE",
  "PIN_MESSAGE",
  "DELETE_MESSAGE",
  "CREATE_POLL",
  "GENERATE_IMAGE",
  "GENERATE_SVG_IMAGE",
  // 2026-08-04: пиннинг вводили как защиту от ЭКСФИЛЬТРАЦИИ и потому смотрели
  // только на исходящие действия. Но чат из payload брали и два входящих:
  // LIST_RECENT_MESSAGES читал историю указанного чата (kinds:["all"], до 200
  // строк с from_name и текстом), а CREATE_TASK клал задачу на доску чужого
  // чата. Первое — прямая зеркальная утечка: не «унести наружу», а «принести
  // внутрь» чужую переписку по одной строчке промпт-инъекции.
  "LIST_RECENT_MESSAGES",
  "CREATE_TASK",
  "SPLIT_TASK",
]);

/**
 * Модель назвала чат, отличный от чата-источника. Отдельная функция, а не
 * `!== ctxChatId` по месту: тот же предикат нужен хендлеру, который обязан
 * СКАЗАТЬ о подмене (см. LIST_RECENT_MESSAGES), а разъехавшиеся копии условия
 * дали бы заметку не про тот случай, который на самом деле сработал.
 */
export function crossChatRequested(
  payloadChatId: number | undefined,
  ctxChatId: number,
): boolean {
  return typeof payloadChatId === "number" && payloadChatId !== ctxChatId;
}

/**
 * Заметка для ВЫДАЧИ, если модель назвала не тот чат. `undefined` — не назвала.
 *
 * Живёт здесь, а не в хендлере, по двум причинам. Первая — формулировка одна
 * на всю поверхность: подмена чата выглядит одинаково у любого инструмента.
 * Вторая — инвариант chat-pinning-invariant.test.ts требует, чтобы чат из
 * payload нигде не читали мимо этих помощников; собери хендлер текст сам, и он
 * читал бы `payload.chat_id` напрямую, то есть ровно тем выражением, за
 * которым инвариант и следит.
 */
export function pinnedChatNote(
  payloadChatId: number | undefined,
  ctxChatId: number,
): string | undefined {
  if (!crossChatRequested(payloadChatId, ctxChatId)) return undefined;
  return (
    `запрошен чат ${payloadChatId}, но инструмент работает только с чатом-источником ` +
    `(${ctxChatId}) — ниже данные чата ${ctxChatId}, а не запрошенного`
  );
}

/**
 * S4 (security 2026-06-10): для исходящих медиа (SEND_PHOTO/SEND_DOCUMENT) ПИНим
 * целевой чат к исходному — чтобы prompt-injected агент не мог унести контент в
 * произвольный чат (exfil). Игнорируем payload.chatId, только логируем попытку.
 */
export function pinnedChatId(
  payloadChatId: number | undefined,
  ctxChatId: number,
  action: string,
): number {
  if (crossChatRequested(payloadChatId, ctxChatId)) {
    log.warn(
      `[security] ${action}: cross-chat target ignored — pinned to originating`,
      { requested: payloadChatId, originating: ctxChatId },
    );
  }
  return ctxChatId;
}

/** Standard result union returned by dispatch handlers. */
export type HandlerResult =
  | { ok: true; result: any }
  /**
   * `sideEffect` — «провал, но что-то уже произошло наружу». Ставит его
   * хендлер, который знает про свой побочный эффект. Читает `gateOrDispatch`:
   * слот rate-limit при таком провале не возвращается, иначе потолок
   * «N сообщений в минуту» не считает как раз те ходы, которые в чат что-то
   * положили.
   *
   * Случай не экзотический — таких мест пять, и они в пяти разных файлах:
   * частичная доставка (`partialSendFailure` в telegram.ts), осиротевший
   * баннер в публичном канале (`handlePublishToChannel` в publish.ts),
   * созданный, но не дооформленный канал (channel.ts) и обе ветки mac.ts —
   * оборванная связь при живом прогоне и уже отправленное уведомление.
   *
   * Поэтому флаг — обязанность КАЖДОГО нового хендлера с внешним эффектом, а
   * не готовая частность: забыл поставить — слот вернулся, и потолок
   * перестал считать ровно те ходы, которые уже что-то положили наружу.
   */
  | { ok: false; error: string; sideEffect?: boolean };
