/**
 * T-704: auto-diagnostic task creation.
 *
 * When an action fails (agent_actions.status='error') we automatically create
 * a "diagnostic" task assigned to the role most likely able to fix the class
 * of error. This is ORTHOGONAL to C15 self-diag (which is an aieng-driven
 * payload-retry loop). T-704 is about systemic problems (missing permissions,
 * missing capabilities) that the aieng retry loop cannot fix on its own.
 *
 * Design notes (from T-700 inter-agent-fix audit):
 *  - Categorize errors by string/regex heuristics — no LLM call required.
 *  - Route by category → role:
 *      permission_denied    → perm
 *      missing_capability   → aieng
 *      rate_limited         → (no task — transient, retried elsewhere)
 *      network              → (no task — orchestrator/C15 retries)
 *      unknown              → orchestrator (escalate)
 *  - Дедуп по (failed_action_id, error_category) есть в коде, но в проде он
 *    НЕ работает и обещать идемпотентность нельзя: `failed_action_id`
 *    приходит из logAction, то есть это свежий crypto.randomUUID() на каждый
 *    вызов, и совпасть пара не может в принципе (аудит 2026-08-09, разбор —
 *    у самого дедупа в createDiagnosticTask). Реальная и единственная граница
 *    потока — троттл `isDiagTaskThrottled` по title. Не снимай его как
 *    «дублирующую защиту»: без него пятьдесят падений одного типа дают
 *    пятьдесят diag-задач на доске владельца.
 *  - Task type is recorded via the `title` prefix ("[diagnostic] …") and via
 *    inputPayload.type='diagnostic' (no schema change to the tasks table).
 */
import { getErrorMessage } from "./errors.ts";
import { db } from "./db.ts";
import { createTask, type Task } from "./tasks.ts";
import { log } from "./log.ts";
import { isDiagTaskThrottled, diagTaskThrottleMax } from "./fix-chain.ts";
import { TASK_TRANSITIONS, type TaskStatus } from "./task-fsm.ts";

/**
 * Действия, чей провал НЕ порождает диагностических задач — ни неявно
 * (C15 self-diag + T-704 в action-dispatch.ts), ни по явному
 * CREATE_DIAGNOSTIC_TASK (dispatch/diagnostic-action.ts). Живёт здесь, потому
 * что оба пути уже импортируют этот модуль: раньше список был продублирован
 * литералами в двух местах и «зеркальность» держалась только комментарием.
 *
 * CREATE_TASK — риск рекурсии: диагностика провала создания задачи сама создаёт
 * задачу, безусловно и независимо от причины.
 *
 * До 2026-08-02 один отказ сплита оставлял на доске ТРИ строки вместо одной:
 *   [split] <название>               failed   —
 *   Tool error: SPLIT_TASK           pending  aieng         ← C15
 *   [diagnostic] unknown: SPLIT_TASK pending  orchestrator  ← T-704
 * Две из трёх просят починить то, что работает как задумано, и обе висят до
 * gc_stale. Родительская задача уже помечена failed и несёт текст причины —
 * этого достаточно и модели, и расследованию.
 */
export const NO_SELF_DIAG_ACTIONS = new Set<string>(["CREATE_TASK"]);

/**
 * Тексты отказов делегирования, которые НЕ являются поломкой: агент попросил
 * то, что правила запрещают. Производит их ветка DELEGATE_TO_ROLE в
 * action-dispatch.ts — сама либо через `skipped` из handoff.ts; SPLIT_TASK
 * склеивает их в `role: <причина>; role: …`.
 *
 * Аудит 2026-08-21: список расходился с производителями в обе стороны. Про
 * мёртвую запись — блок под списком. В другую сторону: двух реально
 * существующих отказов в списке не было, и каждый заводил на доску по две
 * задачи «почини сработавшую защиту» — остановленная политикой роль
 * (`no_available_agent` с маркером) и `delegate_skipped:`.
 *
 * Это ровно тот список, который лежит в основе решения «не заводить диагностику
 * на SPLIT_TASK»: сам по себе actionType такого решения не даёт. Первая
 * редакция правила (2026-08-02) гасила SPLIT_TASK целиком по типу, и вместе с
 * шумом молча съедала настоящие поломки, дающие тот же текст
 * `no roles accepted`: `no resolveAgent in dispatch ctx`,
 * `no handoffDeps in dispatch ctx` (обе — ошибки проводки) и
 * `target agent not found: <role>` (роль в реестре есть, бот мёртв). Их надо
 * чинить, а значит — маршрутизировать на ответственную роль.
 */
export const DELEGATION_REFUSALS: readonly string[] = [
  "cannot delegate to self",
  // Покрывает все три варианта из action-dispatch.ts, включая исчерпание
  // глубины: `delegation cycle detected: path=[…] exceeds max length 5`.
  "delegation cycle",
  // Все кандидаты остановлены политикой. Маркер ставит производитель
  // (action-dispatch.ts, через allCandidatesStopped) именно затем, чтобы
  // недоступность ПО ЗДОРОВЬЮ — тот же текст без маркера — сюда не попала:
  // мёртвый бот это поломка, и диагностика на неё заводиться обязана.
  "(all candidates stopped)",
  // handoff вернул `skipped`: цель остановлена уже в воронке (legacy-путь по
  // @-упоминанию) либо исчерпан бюджет вызовов ролей на ход. Оба места —
  // handoff.ts:299 и :315 — по определению «не запускали», а не «сломалось».
  // Соседний `delegate_failed:` намеренно НЕ здесь: там и настоящий провал.
  "delegate_skipped:",
  // Исходы гейта. Аудит 2026-08-28: список знал отказы самой воронки и ни
  // одного решения гейта — а фан-аут сплита ходит через `gateOrDispatch` и
  // получает именно их. Тексты собирает `gateRefusalText`
  // (action-dispatch.ts:1390), вызывающий кладёт их как `<role>: <текст>`
  // (:864). Все три означают «правила сказали нет» или «не сейчас».
  //
  // Дороже всех обходился `pending_approval:`: при autonomy=manual его
  // возвращает КАЖДОЕ делегирование (DELEGATE_TO_ROLE не в
  // LOW_FRICTION_ACTIONS, ветка manual отвечает approval безусловно —
  // permissions.ts:929). Детей ноль, сплит отвечает `split failed: no roles
  // accepted the task (…)`, и на каждый сплит на доску падали две задачи с
  // просьбой починить сработавший гейт. Под semi_auto то же с `forbidden:`,
  // причём `categorizeError` раскладывал его в permission_denied и уводил на
  // perm.
  //
  // Двоеточие в конце обязательно: без него `forbidden` поймал бы и чужие
  // тексты. Сегментами читаются только ошибки DELEGATE_TO_ROLE и SPLIT_TASK,
  // так что `forbidden:` из mac.ts и telegram.ts сюда не доходит.
  "pending_approval:",
  "rate_limited:",
  "forbidden:",
  // Прямое делегирование под отменённого родителя: отказ
  // `parent task is cancelled` в action-dispatch.ts.
  // Текст сам говорит агенту, что делать вместо этого. Соседний `parent task
  // not found:` намеренно НЕ здесь: отменённая задача есть, ненайденной нет —
  // это висячая ссылка, то есть поломка.
  "parent task is cancelled:",
];

// Аудит 2026-08-20: отсюда убрана строка "delegation depth exceeded". Её не
// производит никто — потолок цепочки (`chain.length > 5`) отвечает текстом
// `delegation cycle detected: path=[…] exceeds max length 5`, а он и так
// ловится подстрокой "delegation cycle" выше.
//
// Запись была не просто мёртвой, а вводящей в заблуждение: список читают как
// «вот чем покрыта глубина», и следующая правка потолка легко переписала бы
// текст ошибки на этот фантом, потеряв реальное покрытие молча. Тест
// split-error-truncation.test.ts тоже строил на ней фикстуру и при этом
// утверждал в комментарии «ровно те тексты, которые выдаёт DELEGATE_TO_ROLE» —
// то есть проверял обрезку на сегментах втрое короче настоящих.

/**
 * Маркер отброшенных при обрезке отказов. Считается отказом: он появляется
 * только тогда, когда отброшенные сегменты были отказами (см. joinDelegationErrors).
 */
const OMITTED_REFUSALS = "further by-design refusals omitted";
/** То же для отброшенных поломок — отказом НЕ считается. */
const OMITTED_ERRORS = "further errors omitted";
/** Запас под самый длинный маркер вместе с разделителем. */
const MARKER_RESERVE = `; +999 ${OMITTED_REFUSALS}`.length;

function isRefusalSegment(s: string): boolean {
  if (s.includes(OMITTED_REFUSALS)) return true;
  return DELEGATION_REFUSALS.some((r) => s.includes(r));
}

/**
 * Аудит 2026-08-09: агрегирующий текст обрезался посередине сегмента, и
 * решение «это отказ по правилам» разваливалось.
 *
 * Писатель (`errors.join("; ").slice(0, 500)` в action-dispatch.ts) и читатель
 * (isByDesignRefusal ниже) — две половины одного протокола, которые жили в
 * разных файлах и не знали друг о друге. Читатель требует, чтобы КАЖДЫЙ
 * сегмент выглядел отказом; писатель резал строку по символу. Начиная примерно
 * с шести ролей 500 символов кончались, последний сегмент приезжал огрызком
 * («frontend: delegation cy»), огрызок под правило не подходил — и на штатный,
 * ожидаемый отказ снова заводились три диагностические задачи на доску. Ровно
 * та засорённость, ради которой правило и писалось.
 *
 * Чиним у писателя: обрезаем по границам сегментов и при нехватке места
 * сохраняем в первую очередь ПОЛОМКИ — они и есть то, ради чего текст читают.
 * Отброшенное честно summarised маркером. Инвариант: вердикт
 * isByDesignRefusal по обрезанному тексту совпадает с вердиктом по полному
 * списку.
 */
export function joinDelegationErrors(errors: string[], limit = 500): string {
  const segs = errors.filter((s) => s.trim() !== "");
  if (!segs.length) return "";
  const joined = segs.join("; ");
  if (joined.length <= limit) return joined;

  const breakages: number[] = [];
  const refusals: number[] = [];
  segs.forEach((s, i) => (isRefusalSegment(s) ? refusals : breakages).push(i));

  // Место под маркер резервируем заранее: раз полный текст в лимит не влез,
  // маркер будет обязательно, и дописать его «сверху» значит лимит нарушить.
  const budget = Math.max(1, limit - MARKER_RESERVE);
  const kept = new Set<number>();
  let used = 0;
  const fits = (s: string) => used + (used ? 2 : 0) + s.length <= budget;
  // Поломки — первым классом: они определяют и вердикт, и содержание.
  for (const order of [breakages, refusals]) {
    for (const i of order) {
      if (!fits(segs[i]!)) continue;
      used += (used ? 2 : 0) + segs[i]!.length;
      kept.add(i);
    }
  }
  // Одна-единственная поломка длиннее лимита: лучше огрызок поломки, чем
  // текст, по которому она неотличима от штатного отказа.
  if (!kept.size) {
    const i = breakages[0] ?? refusals[0]!;
    return segs[i]!.slice(0, limit);
  }

  const lostRefusals = refusals.filter((i) => !kept.has(i)).length;
  const lostBreakages = breakages.filter((i) => !kept.has(i)).length;
  const out = [...kept].sort((a, b) => a - b).map((i) => segs[i]!);
  if (lostBreakages) out.push(`+${lostBreakages} ${OMITTED_ERRORS}`);
  else if (lostRefusals) out.push(`+${lostRefusals} ${OMITTED_REFUSALS}`);
  return out.join("; ");
}

/**
 * Провал целиком объясняется отказами «по правилам»? Для сплита это значит:
 * есть агрегирующий текст и КАЖДЫЙ сегмент `role: причина` — отказ. Хватит
 * одной поломки среди отказов, чтобы диагностика всё-таки завелась.
 */
export function isByDesignRefusal(error: string | null | undefined): boolean {
  if (!error) return false;

  const m = error.match(/^split failed: no roles accepted the task \((.*)\)$/s);
  if (!m) return isRefusalSegment(error);
  const reasons = m[1]!.split("; ").filter((s) => s.trim() !== "");
  // Пустой список причин — это молча упавший createTask (он ловится
  // non-fatal и в errors не попадает). Не отказ, а именно поломка.
  return reasons.length > 0 && reasons.every(isRefusalSegment);
}

/**
 * Общее решение обоих путей самодиагностики: неявного (C15 + T-704 в
 * action-dispatch.ts) и явного (CREATE_DIAGNOSTIC_TASK). Раньше пути держали
 * списки-исключения раздельно, и «зеркальность» гарантировалась комментарием.
 */
export function shouldSkipSelfDiag(
  actionType: string,
  error?: string | null,
): boolean {
  if (NO_SELF_DIAG_ACTIONS.has(actionType)) return true;
  // DELEGATE_TO_ROLE — производитель этих отказов, SPLIT_TASK лишь склеивает
  // их в сводку. Правило висело только на склейке, и прямое делегирование
  // «самому себе» или по кругу заводило те же две мусорные строки на доску
  // (Tool error: … на aieng + [diagnostic] … на orchestrator), обе с просьбой
  // починить сработавшую защиту. Стало заметно, когда фан-аут сплита перевели
  // на gateOrDispatch (аудит 2026-08-12): дети наконец пошли через аудит — и
  // принесли с собой шум, который до этого просто некому было создать.
  if (actionType === "SPLIT_TASK" || actionType === "DELEGATE_TO_ROLE") {
    return isByDesignRefusal(error);
  }
  return false;
}

export type ErrorCategory =
  | "permission_denied"
  | "rate_limited"
  | "missing_capability"
  | "network"
  | "unknown";

export interface DiagnosticInput {
  type: "diagnostic";
  failed_action_id: string;
  error_category: ErrorCategory;
  hypothesis: string;
  original_error: string;
}

/**
 * Categorize an error string into one of the known buckets via regex heuristics.
 *
 * Order matters: rate-limit and permission errors often mention "denied" or
 * "403" together with the more specific cause, so we check the most specific
 * patterns first.
 */
export function categorizeError(error: string | null | undefined): ErrorCategory {
  const s = String(error ?? "").toLowerCase();
  if (!s) return "unknown";

  // rate_limited — explicit 429 / "rate limit" / "too many requests" / "quota".
  if (/\b429\b|rate.?limit|too many requests|quota.?exceed|rate.?exceed/.test(s)) {
    return "rate_limited";
  }

  // permission_denied — auth/permission/forbidden/approval.
  if (
    /permission.?denied|forbidden|\b403\b|\b401\b|not authori[sz]ed|unauthori[sz]ed|requires?.approval|approval.required|permission_denied/.test(
      s,
    )
  ) {
    return "permission_denied";
  }

  // missing_capability — unknown action type, unsupported, not implemented,
  // missing tool / handler / feature.
  if (
    /unknown action|unsupported|not implemented|no handler|missing capability|capability.missing|no such (tool|action|handler)|feature.not.available/.test(
      s,
    )
  ) {
    return "missing_capability";
  }

  // network — ETIMEDOUT / ECONNREFUSED / DNS / fetch failed / 5xx gateway.
  if (
    /etimedout|econnrefused|econnreset|enotfound|getaddrinfo|network|socket hang up|fetch failed|\b50[234]\b|gateway|dns/.test(
      s,
    )
  ) {
    return "network";
  }

  return "unknown";
}

/**
 * Регэксп агрегирующей обёртки сплита. Пишет её ветка `SPLIT_TASK`
 * в action-dispatch.ts, читают отсюда двое: isByDesignRefusal и categorizeAggregateError.
 */
const SPLIT_AGGREGATE_RE = /^split failed: no roles accepted the task \((.*)\)$/s;

/**
 * Форма сегмента склейки: `role: причина`. Именно так их собирает
 * `joinDelegationErrors` из строк вида `${role}: ${gateRefusalText(r)}`.
 * Ключи ролей — строчная латиница с подчёркиванием, поэтому ни русская проза,
 * ни `GENERATE_IMAGE failed (…)`, ни `svg-fallback also failed: …` (дефис и
 * пробел до двоеточия) под неё не подходят.
 */
const AGGREGATE_SEGMENT_RE = /^[a-z][a-z0-9_]*: /;

/** Маркеры отброшенных сегментов из joinDelegationErrors — не сегменты. */
const OMITTED_MARKER_RE = new RegExp(
  `^\\+\\d+ (?:${OMITTED_REFUSALS}|${OMITTED_ERRORS})$`,
);

/**
 * От самой конкретной категории к самой общей, дальше — отложенные. Порядок
 * сегментов в склейке случаен (какая роль ответила раньше), поэтому победитель
 * выбирается по важности, а не по позиции.
 */
const CATEGORY_PRIORITY: readonly ErrorCategory[] = [
  "permission_denied",
  "missing_capability",
  "unknown",
  "rate_limited",
  "network",
];

/**
 * Аудит 2026-08-28: класс сбоя определялся по склейке, а не по сегментам.
 *
 * `res.error` у SPLIT_TASK и у фан-аута DELEGATE_TO_ROLE — это N сегментов
 * `role: причина`, склеенных `"; "` (action-dispatch.ts:873 и :889).
 * `categorizeError` — регэкспы по всей строке, и порядок проверок в нём решал,
 * кто победит. Один сегмент с 429 делал `rate_limited` всю сводку: дальше
 * createDiagnosticTask отвечал `deferred_rate_limited` («ретраи разберутся»),
 * и настоящая поломка в соседнем сегменте не заводила ничего — ретраится-то
 * лимит, а не `unknown action`. Вариант с 403 хуже: задача уезжала на `perm` с
 * уверенной и неверной гипотезой про недостающую строку в permissions.
 *
 * Посегментный разбор в модуле уже был и работал верно (isByDesignRefusal
 * требует, чтобы КАЖДЫЙ сегмент был отказом) — категоризатор им не пользовался.
 *
 * Одиночная строка проходит в `categorizeError` без изменений: у неё сегментов
 * нет, и другого способа её прочитать тоже нет.
 *
 * Аудит 2026-08-29: это обещание не выполнялось. Обёртку проверяли только
 * чтобы снять скобки, а ветка `: s` резала по `"; "` любую строку. Сегментов у
 * прозы нет, а точка с запятой есть — и половинки шли в приоритеты наравне с
 * настоящими сегментами. Хвост прозы обычно не ошибка вовсе, то есть даёт
 * `unknown`, а `unknown` в CATEGORY_PRIORITY стоит ВЫШЕ `rate_limited`
 * (осознанно — для настоящих склеек). Так осмысленное начало проигрывало
 * бессмысленному концу.
 *
 * Живых производителей двое, и оба возвращают `{ok:false, error}` из
 * `dispatchAction`, откуда `res.error` идёт прямо в `createDiagnosticTask`:
 * отмена публикации с уборкой осиротевшего баннера («… (429 …); баннер удалён,
 * канал чист») и провал GENERATE_IMAGE вместе с svg-фолбэком. Троттлинг
 * Telegram превращался в `unknown`, `unknown` — в задачу оркестратору
 * «Manual triage» на доске владельца. Ровно та засорённость доски, ради
 * которой этот модуль и существует.
 *
 * Теперь без обёртки склейка опознаётся по форме сегментов: `role: причина`,
 * как их собирает `joinDelegationErrors`. Способность читать необёрнутую
 * склейку сохранена (докблок называет её вторым источником), сужен вход.
 */
export function categorizeAggregateError(
  error: string | null | undefined,
): ErrorCategory {
  const s = String(error ?? "");
  if (!s.trim()) return categorizeError(s);

  const m = s.match(SPLIT_AGGREGATE_RE);
  const segs = (m ? m[1]! : s)
    .split("; ")
    .map((x) => x.trim())
    .filter((x) => x !== "" && !OMITTED_MARKER_RE.test(x));
  if (segs.length < 2) return categorizeError(s);
  // Обёртка — признак склейки сама по себе. Без неё требуем, чтобы КАЖДЫЙ
  // сегмент имел форму `role: причина`: иначе это проза, а не набор.
  if (!m && !segs.every((x) => AGGREGATE_SEGMENT_RE.test(x))) {
    return categorizeError(s);
  }

  // Штатные отказы класс сбоя не определяют: «не запускали» — не «сломалось».
  // Если поломок нет вовсе, решаем по всему набору, как раньше: такой набор
  // до сюда не доходит (его отсекает shouldSkipSelfDiag), и выдумывать ему
  // отдельное поведение незачем.
  const breakages = segs.filter((x) => !isRefusalSegment(x));
  const cats = new Set((breakages.length ? breakages : segs).map(categorizeError));
  for (const c of CATEGORY_PRIORITY) if (cats.has(c)) return c;
  // Аудит 2026-08-28: сюда не приходят. `segs.length >= 2` проверен выше, то
  // есть набор непустой, а CATEGORY_PRIORITY перечисляет ВСЕ пять членов
  // ErrorCategory — значит цикл выше всегда возвращает. Строка остаётся
  // страховкой на случай, если в union добавят имя, а в приоритеты — нет;
  // тогда «unknown» отправит случай оркестратору, а не потеряет его. Тест на
  // полноту приоритетов: tests/audit-2026-08-28-docblock-drift.test.ts.
  return "unknown";
}

/**
 * Pick the responsible role for a given category. Returns null when no task
 * should be created (rate_limited / network — handled elsewhere).
 */
export function pickResponsibleRole(category: ErrorCategory): string | null {
  switch (category) {
    case "permission_denied":
      return "perm";
    case "missing_capability":
      return "aieng";
    case "rate_limited":
      return null; // transient, anthropic-client retries on its own
    case "network":
      return null; // C15 / orchestrator handles network retries
    case "unknown":
      return "orchestrator";
    default:
      return null;
  }
}

/**
 * Build a short hypothesis sentence for the diag task description.
 */
export function buildHypothesis(
  category: ErrorCategory,
  actionType: string,
  error: string,
): string {
  const short = error.length > 200 ? error.slice(0, 200) + "…" : error;
  switch (category) {
    case "permission_denied":
      return `Action ${actionType} was denied. Likely missing permission row or autonomy gate. Error: ${short}`;
    case "missing_capability":
      return `Action ${actionType} hit a missing capability (unknown action / unsupported feature). Error: ${short}`;
    case "rate_limited":
      return `Action ${actionType} was rate-limited. Backoff and retry. Error: ${short}`;
    case "network":
      return `Action ${actionType} failed with a transient network error. Will be retried. Error: ${short}`;
    case "unknown":
    default:
      return `Action ${actionType} failed with an uncategorized error. Manual triage. Error: ${short}`;
  }
}

export interface CreateDiagnosticTaskInput {
  failedActionId: string;
  actionType: string;
  error: string;
  chatId: number;
  /** Agent that originally attempted the action — used as createdBy on the task. */
  originatingAgent?: string;
  /** Parent task id (the task whose action failed), if any. */
  parentTaskId?: string | null;
}

export interface CreateDiagnosticTaskResult {
  /** Created task, or null if no task was created (rate_limited / network / dedup hit). */
  task: Task | null;
  category: ErrorCategory;
  /** Why we did not create a task, when task === null. */
  skippedReason?:
    | "deferred_rate_limited"
    | "deferred_network"
    | "duplicate"
    | "throttled"
    | "no_role"
    | "error";
}

/**
 * Незавершённые статусы задачи — те, из которых FSM ещё куда-то выпускает.
 *
 * Аудит 2026-08-29: окно дедупликации ниже было записано перечислением
 * `('pending','running')` и отстало от таблицы переходов. `awaiting_review` и
 * `awaiting_approval` — законные состояния живой задачи (`REQUEST_REVIEW`,
 * кнопки Mini App), и диагностика, припаркованная в любом из них, для дедупа
 * становилась невидимой: на повторе того же сбоя заводился дубль, и так до
 * потолка `isDiagTaskThrottled` (5 задач в час на заголовок). Владелец получал
 * на доску пять карточек про одну и ту же поломку — ровно та засорённость,
 * ради которой дедуп и написан.
 *
 * Считаем из `TASK_TRANSITIONS`, а не перечисляем: список статусов уже
 * расходился между копиями (см. докблок task-fsm.ts), и второе перечисление
 * здесь разошлось бы снова при следующем добавлении статуса.
 */
const LIVE_STATUSES: readonly TaskStatus[] = (
  Object.keys(TASK_TRANSITIONS) as TaskStatus[]
).filter((s) => TASK_TRANSITIONS[s].length > 0);

const LIVE_STATUS_PLACEHOLDERS = LIVE_STATUSES.map(() => "?").join(", ");

/**
 * Check whether a live (non-terminal) diagnostic task already exists for this
 * (failed_action_id, error_category) pair.
 *
 * We dedupe via the JSON input column since adding a partial-unique index on
 * a JSON-extracted value is brittle across sqlite versions. The LIKE pattern
 * is anchored on the literal keys we emit below.
 */
export function findExistingDiagnostic(
  failedActionId: string,
  category: ErrorCategory,
): { id: string } | null {
  const row = db
    .prepare(
      `SELECT id FROM tasks
       WHERE status IN (${LIVE_STATUS_PLACEHOLDERS})
         AND input LIKE ?
         AND input LIKE ?
         AND input LIKE '%"type":"diagnostic"%'
       LIMIT 1`,
    )
    .get(
      ...LIVE_STATUSES,
      `%"failed_action_id":"${failedActionId}"%`,
      `%"error_category":"${category}"%`,
    ) as { id: string } | undefined;
  return row ?? null;
}

/**
 * Create an auto-diagnostic task for a failed action. See module docstring.
 *
 * Idempotent: returns the existing-task path with skippedReason='duplicate'
 * if a live (non-terminal) diag for the same (action, category) pair exists.
 */
export function createDiagnosticTask(
  input: CreateDiagnosticTaskInput,
): CreateDiagnosticTaskResult {
  const category = categorizeAggregateError(input.error);
  const responsible = pickResponsibleRole(category);

  if (category === "rate_limited") {
    return { task: null, category, skippedReason: "deferred_rate_limited" };
  }
  if (category === "network") {
    return { task: null, category, skippedReason: "deferred_network" };
  }
  // Аудит 2026-08-28: ветка недостижима, и это стоит знать читателю. null
  // отдают ровно `rate_limited` и `network` (pickResponsibleRole), а обе
  // категории уже вернулись выше со своими причинами. Оставлено намеренно:
  // это последний рубеж, если в ErrorCategory добавят имя и забудут строку в
  // pickResponsibleRole. Соседний вызывающий (dispatch/diagnostic-action.ts:
  // 205-218) сознательно устроен наоборот — там условие ровно `!responsible`,
  // без перечисления категорий; расхождение здесь не случайно: там нужен один
  // отказ, здесь — разные `skippedReason` для разных причин.
  if (!responsible) {
    return { task: null, category, skippedReason: "no_role" };
  }

  // Idempotent dedup.
  const existing = findExistingDiagnostic(input.failedActionId, category);
  if (existing) {
    return { task: null, category, skippedReason: "duplicate" };
  }

  // Аудит 2026-08-09: анти-шторм. Дедуп выше ключуется на failed_action_id, а
  // сюда он приходит из logAction, то есть это свежий crypto.randomUUID() на
  // каждый вызов — совпасть он не может в принципе. Значит единственной
  // границей этого пути был дедуп, которого фактически нет: пятьдесят падений
  // одного типа = пятьдесят diag-задач. У соседней C15-петли троттл есть
  // (action-dispatch.ts, T-705); здесь его забыли. Считаем по любому
  // исполнителю: ответственную роль выбирает pickResponsibleRole, и фильтр по
  // 'aieng' показывал бы ноль.
  const title = `[diagnostic] ${category}: ${input.actionType}`;
  if (isDiagTaskThrottled(title, Date.now(), null)) {
    log.warn("[diagnostic] throttled — слишком много diag-задач этого класса", {
      title,
      max_per_hour: diagTaskThrottleMax(),
    });
    return { task: null, category, skippedReason: "throttled" };
  }

  const hypothesis = buildHypothesis(category, input.actionType, input.error);
  const payload: DiagnosticInput = {
    type: "diagnostic",
    failed_action_id: input.failedActionId,
    error_category: category,
    hypothesis,
    original_error: input.error,
  };

  try {
    const task = createTask({
      chatId: input.chatId,
      createdBy: input.originatingAgent ?? "system",
      assignedTo: responsible,
      parentId: input.parentTaskId ?? null,
      title: `[diagnostic] ${category}: ${input.actionType}`,
      description: hypothesis,
      inputPayload: payload,
      priority: 2,
    });
    log.info("[diagnostic] created task", {
      taskId: task.id,
      category,
      responsible,
      failedActionId: input.failedActionId,
    });
    return { task, category };
  } catch (e) {
    // A real createTask failure (DB error, FK violation, etc.) is NOT a dedup
    // hit — reporting it as "duplicate" would silently mask genuine incidents.
    // Surface it as a distinct "error" reason so callers/metrics can tell the
    // two apart.
    log.error("[diagnostic] createTask failed", {
      error: getErrorMessage(e),
    });
    return { task: null, category, skippedReason: "error" };
  }
}
