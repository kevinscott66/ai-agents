/**
 * macctl — исполнитель закрытого списка команд MAC_CONTROL на Mac владельца.
 *
 * Каждая команда превращается в фиксированный argv без оболочки (execFile):
 * путь к программе зашит здесь, аргументы — только проверенные числа, псевдоним
 * приложения из локального MAC_APPS или название напоминания/события, которое
 * уходит отдельным аргументом помощнику EventKit. Всё выключено, пока владелец
 * не поставит MAC_CONTROL_ENABLED=true в окружении демона.
 *
 * Запуск вручную: `bun macctl.ts '{"command":"volume","level":30}'`.
 */
import { execFile } from "node:child_process";
import { sanitizeChildEnv } from "./child-env.ts";
import { calendarHelperPath } from "./calendar-helper.ts";
import { parseMacControl, parseMacReminders, type MacControl } from "../lib/mac-control.ts";
import type { NativeExec } from "./assistant.ts";

/** Коды, которые помощник EventKit печатает в stderr ровно одной строкой. */
const HELPER_CODES = ["calendar_access_required", "reminders_access_required", "invalid_arguments"];

export const controlExec: NativeExec = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20_000, signal, killSignal: "SIGKILL", maxBuffer: 60_000, env: sanitizeChildEnv(process.env) }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    // Текст stderr наружу не уходит: только фиксированный код.
    const line = stderr.trim();
    if (HELPER_CODES.includes(line)) return reject(new Error(line));
    // -1743: процессу не выдано разрешение «Автоматизация» (System Events).
    reject(new Error(/\(-1743\)/.test(stderr) ? "automation_access_required" : "native_command_failed"));
  });
});

export interface ControlEnv {
  MAC_CONTROL_ENABLED?: string;
  MAC_CALENDAR_ENABLED?: string;
  /** Постоянная папка помощника EventKit вне релиза — см. calendar-helper.ts. */
  MAC_CALENDAR_BIN_DIR?: string;
  MAC_APPS?: string;
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** MAC_APPS=`alias=bundle.id,...` — единственный способ назвать приложение. */
export function parseMacApps(raw: string | undefined): Map<string, string> {
  const apps = new Map<string, string>();
  for (const part of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [alias, id, extra] = part.split("=").map((x) => x.trim());
    if (extra !== undefined || !/^[a-z0-9_-]{1,32}$/.test(alias ?? "") || !BUNDLE_ID.test(id ?? "")) {
      throw new Error("apps_not_configured");
    }
    apps.set(alias!, id!);
  }
  if (apps.size > 32) throw new Error("apps_not_configured");
  return apps;
}

const sec = (ms: number) => String(Math.floor(ms / 1000));
/** Напоминания и календарь идут через тот же помощник EventKit и тот же выключатель. */
function calendarHelper(env: ControlEnv): string {
  if (env.MAC_CALENDAR_ENABLED !== "true") throw new Error("calendar_disabled");
  return calendarHelperPath(env.MAC_CALENDAR_BIN_DIR);
}

/** argv для команды. Отдельно от исполнения, чтобы тест видел ровно то, что запустится. */
export function controlArgv(c: MacControl, env: ControlEnv): [string, string[]] {
  switch (c.command) {
    case "lock": return ["/usr/bin/pmset", ["displaysleepnow"]];
    case "sleep": return ["/usr/bin/pmset", ["sleepnow"]];
    case "volume": return ["/usr/bin/osascript", ["-e", `set volume output volume ${c.level}`]];
    case "mute": return ["/usr/bin/osascript", ["-e", "set volume output muted true"]];
    case "unmute": return ["/usr/bin/osascript", ["-e", "set volume output muted false"]];
    case "shutdown": return ["/usr/bin/osascript", ["-e", 'tell application "System Events" to shut down']];
    case "restart": return ["/usr/bin/osascript", ["-e", 'tell application "System Events" to restart']];
    case "open_app": {
      const id = parseMacApps(env.MAC_APPS).get(c.app);
      if (!id) throw new Error("app_not_allowed");
      return ["/usr/bin/open", ["-b", id]];
    }
    case "reminders": return [calendarHelper(env), ["reminders"]];
    case "reminder_add": return [calendarHelper(env), ["reminder-add", c.title, ...(c.dueAt ? [sec(c.dueAt)] : [])]];
    case "event_add": return [calendarHelper(env), ["event-add", c.title, sec(c.startAt), sec(c.endAt)]];
  }
}

export async function runMacControl(
  raw: unknown,
  // MAC_CALENDAR_BIN_DIR здесь обязателен, хотя выключателем не является: без него
  // помощник ищется внутри папки релиза, а разрешение macOS выдано постоянному пути.
  // Демон зовёт эту функцию без env (daemon.ts, кадр control), и пропуск переменной
  // означал не «календарь выключен», а молчаливый native_command_failed на каждом
  // напоминании и событии — при полностью верной настройке владельца.
  env: ControlEnv = {
    MAC_CONTROL_ENABLED: process.env.MAC_CONTROL_ENABLED,
    MAC_CALENDAR_ENABLED: process.env.MAC_CALENDAR_ENABLED,
    MAC_CALENDAR_BIN_DIR: process.env.MAC_CALENDAR_BIN_DIR,
    MAC_APPS: process.env.MAC_APPS,
  },
  exec: NativeExec = controlExec,
  signal?: AbortSignal,
): Promise<string> {
  if (env.MAC_CONTROL_ENABLED !== "true") throw new Error("control_disabled");
  // Повторный строгий разбор: демон не доверяет тому, что мост уже проверил.
  const control = parseMacControl(raw);
  if (!control) throw new Error("invalid_control");
  const [file, args] = controlArgv(control, env);
  if (signal?.aborted) throw new Error("assistant_cancelled");
  const out = await exec(file, args, signal);
  if (signal?.aborted) throw new Error("assistant_cancelled");
  if (control.command === "reminders") return JSON.stringify(parseMacReminders(out));
  return JSON.stringify({ done: control.command });
}

/** Наружу — только фиксированные коды, без stderr и личных данных. */
export function controlErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return [
    "control_disabled", "invalid_control", "app_not_allowed", "apps_not_configured", "calendar_disabled",
    "calendar_access_required", "reminders_access_required", "automation_access_required", "invalid_arguments",
    "calendar_bin_dir_invalid",
    "assistant_cancelled",
  ].includes(code) ? code : "control_failed";
}

if (import.meta.main) {
  runMacControl(JSON.parse(process.argv[2] ?? "null"))
    .then((out) => console.log(out))
    .catch((error) => { console.error(controlErrorCode(error)); process.exit(1); });
}
