/**
 * Управление личным Mac владельца: закрытый список команд (MAC_CONTROL).
 *
 * Модуль без побочек: его импортируют и сервер (разбор ввода модели, карточка
 * подтверждения), и демон на Mac (повторный строгий разбор кадра). Список
 * команд — единственный источник: ни модель, ни мост не могут прислать
 * произвольную команду, путь к программе или имя приложения — приложение
 * называется коротким псевдонимом, который Mac сверяет со своим MAC_APPS.
 *
 * Выключение и перезагрузка есть в списке, но всегда идут через подтверждение
 * владельца (lib/approval-policy.ts). Остальные команды обратимы и касаются
 * только его машины.
 */
import { DAY_MS } from "./time-constants.ts";

export const MAC_CONTROL_COMMANDS = [
  "lock",
  "sleep",
  "volume",
  "mute",
  "unmute",
  "open_app",
  "reminders",
  "reminder_add",
  "event_add",
  "shutdown",
  "restart",
] as const;
export type MacControlCommand = (typeof MAC_CONTROL_COMMANDS)[number];

export type MacControl =
  | { command: "lock" | "sleep" | "mute" | "unmute" | "reminders" | "shutdown" | "restart" }
  | { command: "volume"; level: number }
  | { command: "open_app"; app: string }
  | { command: "reminder_add"; title: string; dueAt?: number }
  | { command: "event_add"; title: string; startAt: number; endAt: number };

export const MAC_TITLE_MAX = 200;
export const MAC_EVENT_MAX_MS = DAY_MS;
const APP_ALIAS = /^[a-z0-9_-]{1,32}$/;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Название напоминания или события: одна видимая строка без управляющих символов. */
export function validMacTitle(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAC_TITLE_MAX && !HIDDEN.test(v);
}

/**
 * Строгий разбор команды. Лишние поля — отказ, а не молчаливый пропуск:
 * рассинхрон версий моста и демона не должен менять смысл команды.
 */
export function parseMacControl(raw: unknown): MacControl | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(",");
  switch (m.command) {
    case "lock":
    case "sleep":
    case "mute":
    case "unmute":
    case "reminders":
    case "shutdown":
    case "restart":
      return keys === "command" ? { command: m.command } : null;
    case "volume":
      return keys === "command,level" && Number.isInteger(m.level) && (m.level as number) >= 0 && (m.level as number) <= 100
        ? { command: "volume", level: m.level as number } : null;
    case "open_app":
      return keys === "app,command" && typeof m.app === "string" && APP_ALIAS.test(m.app)
        ? { command: "open_app", app: m.app } : null;
    case "reminder_add":
      if (!validMacTitle(m.title)) return null;
      if (keys === "command,title") return { command: "reminder_add", title: m.title };
      return keys === "command,dueAt,title" && isTime(m.dueAt)
        ? { command: "reminder_add", title: m.title, dueAt: m.dueAt } : null;
    case "event_add":
      return keys === "command,endAt,startAt,title" && validMacTitle(m.title) && isTime(m.startAt) && isTime(m.endAt) &&
        m.endAt > m.startAt && m.endAt - m.startAt <= MAC_EVENT_MAX_MS
        ? { command: "event_add", title: m.title, startAt: m.startAt, endAt: m.endAt } : null;
    default:
      return null;
  }
}

/** Команды, которые необратимо прерывают работу машины. */
export function isMacPowerOff(command: unknown): boolean {
  return command === "shutdown" || command === "restart";
}

/** Короткое описание для карточки подтверждения и журнала. */
export function describeMacControl(c: MacControl, formatTime: (ms: number) => string): string {
  switch (c.command) {
    case "lock": return "заблокировать экран Mac";
    case "sleep": return "усыпить Mac";
    case "mute": return "выключить звук на Mac";
    case "unmute": return "включить звук на Mac";
    case "volume": return `громкость Mac ${c.level}%`;
    case "open_app": return `открыть приложение «${c.app}» на Mac`;
    case "reminders": return "показать напоминания Mac";
    case "reminder_add": return `напоминание Mac «${c.title}»${c.dueAt ? ` на ${formatTime(c.dueAt)}` : ""}`;
    case "event_add": return `событие в календаре Mac «${c.title}» ${formatTime(c.startAt)}–${formatTime(c.endAt)}`;
    case "shutdown": return "ВЫКЛЮЧИТЬ Mac";
    case "restart": return "ПЕРЕЗАГРУЗИТЬ Mac";
  }
}

export interface MacReminder {
  title: string;
  due: string | null;
}

/** Ответ помощника на `reminders`: ограниченный список, только название и срок. */
export function parseMacReminders(raw: string): { reminders: MacReminder[]; truncated: boolean } {
  const d = JSON.parse(raw);
  if (!d || !Array.isArray(d.reminders) || d.reminders.length > 40 || typeof d.truncated !== "boolean") {
    throw new Error("invalid_reminders_result");
  }
  for (const r of d.reminders) {
    if (!r || typeof r.title !== "string" || r.title.length > MAC_TITLE_MAX ||
        !(r.due === null || (typeof r.due === "string" && Number.isFinite(Date.parse(r.due))))) {
      throw new Error("invalid_reminder");
    }
  }
  return { reminders: d.reminders.map((r: MacReminder) => ({ title: r.title, due: r.due })), truncated: d.truncated };
}
