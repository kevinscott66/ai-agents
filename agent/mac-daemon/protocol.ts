/**
 * Протокол моста ↔ демона: типы входящих сообщений и их разбор.
 *
 * Вынесено из `daemon.ts` (T-726) по двум причинам, и вторая важнее первой:
 *
 *   1. `daemon.ts` — скрипт с побочками на импорте (проверяет env и делает
 *      `process.exit(1)`), поэтому в тест его не втащить. Разбор протокола в
 *      отдельном модуле без побочек тестируется напрямую.
 *   2. До этого входящее сообщение уходило в обработчик как `msg as RunMsg` —
 *      слепой каст. `run` без `project` (или с числом вместо строки) не
 *      отсеивался: `pathResolve` бросал TypeError уже внутри `handleRun`,
 *      `.catch` его логировал, и **ответа мост не получал вовсе**. Для
 *      вызывающего это выглядело как `mac_timeout` — то есть «мак завис», а не
 *      «сообщение кривое». Ровно один `mac_timeout` в прод-логе так и остался
 *      неразобранным.
 *
 * Разбор нарочно строгий: чужое поле игнорируем, кривой тип — отказ. Мост
 * аутентифицирован секретом, но «аутентифицирован» не значит «шлёт валидное»:
 * рассинхрон версий моста и демона выглядит именно так.
 */

/** Режимы разрешений, которые понимает демон (их пять, у CLI — четыре). */
export const RUN_MODES = [
  "ask",
  "accept_edits",
  "plan",
  "auto",
  "bypass",
] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Режимы разрешений самого Claude CLI (`--permission-mode`). */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export interface RunMsg {
  type: "run";
  id: string;
  project: string;
  prompt: string;
  mode: RunMode;
}

export interface PingMsg {
  type: "ping";
}
export interface AuthOkMsg {
  type: "auth_ok";
}
export interface AuthFailMsg {
  type: "auth_fail";
  error?: string;
}
export interface StopMsg {
  type: "stop";
}
/**
 * Точечная отмена одного прогона по id. Появилась в main уже после того, как
 * эта ветка была срезана, и без строки здесь строгий разбор молча ронял бы её
 * в `default` — то есть брошенный `claude` продолжал бы работать в проекте
 * владельца, ровно тот дефект, ради которого `cancel` и заводили.
 */
export interface CancelMsg {
  type: "cancel";
  id: string;
}

export type BridgeMsg =
  | RunMsg
  | PingMsg
  | AuthOkMsg
  | AuthFailMsg
  | StopMsg
  | CancelMsg;

/** Кривое `run`, у которого всё же есть годный `id` — на такое можно ответить. */
export interface BadRunMsg {
  type: "bad_run";
  id: string;
  reason: string;
}

/**
 * Результат разбора: понятное сообщение, кривой `run` с адресуемым `id`,
 * либо `null` — «молча выбросить» (мусор, неизвестный тип, `run` без id:
 * отвечать некуда, мост всё равно не сопоставит ответ с запросом).
 */
export type ParsedMsg = BridgeMsg | BadRunMsg | null;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Разобрать сырой кадр WebSocket. Никогда не бросает. */
export function parseBridgeMsg(raw: unknown): ParsedMsg {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === "string" ? raw : String(raw));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const m = obj as Record<string, unknown>;
  switch (m.type) {
    case "ping":
      return { type: "ping" };
    case "auth_ok":
      return { type: "auth_ok" };
    case "auth_fail":
      return {
        type: "auth_fail",
        error: typeof m.error === "string" ? m.error : undefined,
      };
    case "stop":
      return { type: "stop" };
    case "cancel":
      // Без id отменять нечего: id — единственное, чем прогон адресуется.
      return isNonEmptyString(m.id) ? { type: "cancel", id: m.id } : null;
    case "run": {
      // Без id отвечать некуда: мост сопоставляет ответ по id и на кадр без него
      // всё равно ничего не ждёт. Роняем молча.
      if (!isNonEmptyString(m.id)) return null;
      if (!isNonEmptyString(m.project))
        return { type: "bad_run", id: m.id, reason: "project must be a non-empty string" };
      if (!isNonEmptyString(m.prompt))
        return { type: "bad_run", id: m.id, reason: "prompt must be a non-empty string" };
      // mode отсутствует → самый строгий режим. Неизвестная строка — отказ, а не
      // тихий фолбэк: рассинхрон версий не должен молча менять права исполнения.
      if (m.mode !== undefined && !RUN_MODES.includes(m.mode as RunMode))
        return {
          type: "bad_run",
          id: m.id,
          reason: `unknown mode: ${String(m.mode)} (expected ${RUN_MODES.join("|")})`,
        };
      return {
        type: "run",
        id: m.id,
        project: m.project,
        prompt: m.prompt,
        mode: (m.mode as RunMode) ?? "ask",
      };
    }
    default:
      return null;
  }
}

/**
 * Наши пять режимов → четыре режима CLI.
 *
 * `auto` — исторический синоним `accept_edits`: отдельного «исполнять всё без
 * спроса» между acceptEdits и bypassPermissions у CLI нет, и придумывать его
 * здесь нельзя (SEC-audit LOW-1: раньше `auto` уходило в CLI как есть, а
 * неизвестное значение будущий CLI может счесть разрешающим).
 */
export function toPermissionMode(mode: RunMode): PermissionMode {
  switch (mode) {
    case "accept_edits":
    case "auto":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "bypass":
      return "bypassPermissions";
    case "ask":
    default:
      return "default";
  }
}
