/**
 * MAC_CONTROL: закрытый список команд на Mac владельца. Проверяем каждую
 * границу по отдельности — разбор, сборку payload из ввода модели, argv
 * исполнителя, протокол демона и обработчик.
 */
import { describe, expect, test } from "bun:test";
import { parseMacControl, parseMacReminders, describeMacControl } from "../lib/mac-control.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { handleMacControl } from "../lib/dispatch/mac.ts";
import { sendControlToMac } from "../lib/mac-bridge.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { controlArgv, controlErrorCode, parseMacApps, runMacControl } from "../mac-daemon/macctl.ts";
import { calendarHelperPath } from "../mac-daemon/calendar-helper.ts";
import { parseBridgeMsg } from "../mac-daemon/protocol.ts";

const ON = { MAC_CONTROL_ENABLED: "true", MAC_CALENDAR_ENABLED: "true", MAC_APPS: "notes=com.apple.Notes" };
const HOUR = 3_600_000;
const future = (h: number) => Date.now() + h * HOUR;

describe("parseMacControl", () => {
  test("accepts every command in its exact shape", () => {
    expect(parseMacControl({ command: "lock" })).toEqual({ command: "lock" });
    expect(parseMacControl({ command: "volume", level: 0 })).toEqual({ command: "volume", level: 0 });
    expect(parseMacControl({ command: "open_app", app: "notes" })).toEqual({ command: "open_app", app: "notes" });
    expect(parseMacControl({ command: "reminder_add", title: "хлеб" })).toEqual({ command: "reminder_add", title: "хлеб" });
    expect(parseMacControl({ command: "event_add", title: "созвон", startAt: 1_000, endAt: 2_000 })).not.toBeNull();
  });

  test("rejects extra fields, junk types and unknown commands", () => {
    const bad: unknown[] = [
      null, [], "lock", { command: "rm" }, { command: "lock", extra: 1 },
      { command: "volume", level: 101 }, { command: "volume", level: 5.5 }, { command: "volume", level: "5" },
      { command: "open_app", app: "/Applications/Terminal.app" }, { command: "open_app", app: "com.apple.Terminal" },
      { command: "reminder_add", title: "a\nb" }, { command: "reminder_add", title: `a${String.fromCodePoint(0x202e)}b` },
      { command: "reminder_add", title: "я".repeat(201) }, { command: "reminder_add", title: "x", dueAt: -1 },
      { command: "event_add", title: "x", startAt: 2_000, endAt: 1_000 },
      { command: "event_add", title: "x", startAt: 1, endAt: 1 + 24 * HOUR + 1 },
    ];
    for (const raw of bad) expect(parseMacControl(raw)).toBeNull();
  });

  test("description names shutdown loudly", () => {
    expect(describeMacControl({ command: "shutdown" }, String)).toBe("ВЫКЛЮЧИТЬ Mac");
  });
});

describe("buildPayload MAC_CONTROL", () => {
  const build = (i: Record<string, unknown>) => buildPayload("MAC_CONTROL", i, { agentKey: "orchestrator" });

  test("app alias is normalized, time strings become ms", () => {
    expect(build({ command: "open_app", app: " Notes " })).toEqual({ ok: true, payload: { command: "open_app", app: "notes" } });
    // Завтра в 10:00 и 11:00 по Москве: окно напоминаний не пускает далёкое будущее.
    const d = new Date(Date.now() + 27 * HOUR);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const msk = (h: number) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 3);
    const r = build({ command: "event_add", title: "созвон", start: `${day} 10:00`, end: `${day}T11:00:00+03:00` });
    expect(r.ok && r.payload).toEqual({ command: "event_add", title: "созвон", startAt: msk(10), endAt: msk(11) });
  });

  test("model junk is refused with a reason", () => {
    expect(build({ command: "run_shell" }).ok).toBe(false);
    expect(build({ command: "volume", level: 150 }).ok).toBe(false);
    expect(build({ command: "reminder_add" }).ok).toBe(false);
    const past = build({ command: "reminder_add", title: "x", due: "2001-01-01 10:00" });
    expect(!past.ok && past.error.startsWith("due")).toBe(true);
    expect(build({ command: "event_add", title: "x", start: "2026-12-01 11:00", end: "2026-12-01 10:00" }).ok).toBe(false);
  });
});

describe("macctl", () => {
  test("argv is fixed per command, no shell", () => {
    expect(controlArgv({ command: "lock" }, ON)).toEqual(["/usr/bin/pmset", ["displaysleepnow"]]);
    expect(controlArgv({ command: "volume", level: 30 }, ON)).toEqual(["/usr/bin/osascript", ["-e", "set volume output volume 30"]]);
    expect(controlArgv({ command: "open_app", app: "notes" }, ON)).toEqual(["/usr/bin/open", ["-b", "com.apple.Notes"]]);
    const [helper, args] = controlArgv({ command: "reminder_add", title: "a; rm -rf ~", dueAt: 1_700_000_000_500 }, ON);
    expect(helper.endsWith("/bin/agent-calendar-run")).toBe(true);
    expect(args).toEqual(["reminder-add", "a; rm -rf ~", "1700000000"]);
  });

  test("switches and allowlists refuse before anything runs", async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => { calls.push([file, ...args]); return ""; };
    const code = (p: Promise<unknown>) => p.then(() => "passed", controlErrorCode);
    expect(await code(runMacControl({ command: "lock" }, { ...ON, MAC_CONTROL_ENABLED: undefined }, exec))).toBe("control_disabled");
    expect(await code(runMacControl({ command: "open_app", app: "terminal" }, ON, exec))).toBe("app_not_allowed");
    expect(await code(runMacControl({ command: "reminders" }, { ...ON, MAC_CALENDAR_ENABLED: "false" }, exec))).toBe("calendar_disabled");
    expect(await code(runMacControl({ command: "lock", x: 1 }, ON, exec))).toBe("invalid_control");
    expect(calls).toEqual([]);
    expect(await runMacControl({ command: "mute" }, ON, exec)).toBe('{"done":"mute"}');
    expect(calls).toHaveLength(1);
  });

  test("reminders output is re-validated, errors are fixed codes", async () => {
    const ok = JSON.stringify({ reminders: [{ title: "хлеб", due: null }], truncated: false });
    expect(JSON.parse(await runMacControl({ command: "reminders" }, ON, async () => ok)).reminders).toHaveLength(1);
    await expect(runMacControl({ command: "reminders" }, ON, async () => '{"reminders":"x"}')).rejects.toThrow();
    expect(controlErrorCode(new Error("/Users/owner/secret path"))).toBe("control_failed");
  });

  test("календарь зовётся через прокладку, а она — из постоянной папки", () => {
    // Помощника EventKit нельзя звать напрямую: TCC спрашивает разрешение у bun,
    // диалога нет, доступа нет. И путь должен пережить выкатку — запись TCC
    // привязана к нему, а папка релиза меняется на каждом релизе.
    expect(calendarHelperPath("/opt/agent/bin/")).toBe("/opt/agent/bin/agent-calendar-run");
    expect(calendarHelperPath(" /opt/agent/bin ")).toBe("/opt/agent/bin/agent-calendar-run");
    expect(calendarHelperPath(undefined).endsWith("/mac-daemon/bin/agent-calendar-run")).toBe(true);
    expect(calendarHelperPath("")).toBe(calendarHelperPath(undefined));
    expect(() => calendarHelperPath("bin")).toThrow("calendar_bin_dir_invalid");
    const [helper] = controlArgv({ command: "reminders" }, { ...ON, MAC_CALENDAR_BIN_DIR: "/opt/agent/bin" });
    expect(helper).toBe("/opt/agent/bin/agent-calendar-run");
    expect(controlErrorCode(new Error("calendar_bin_dir_invalid"))).toBe("calendar_bin_dir_invalid");
  });

  test("окружение по умолчанию несёт и папку помощника", async () => {
    // Демон зовёт runMacControl без env (daemon.ts, кадр control), поэтому список
    // переменных по умолчанию — это и есть настройка напоминаний на живом Mac.
    // Пока MAC_CALENDAR_BIN_DIR в нём не было, помощник искался внутри папки
    // релиза: разрешение macOS выдано постоянному пути, и владелец получал
    // control_failed при полностью верной настройке.
    const saved = { ...process.env };
    const calls: string[][] = [];
    try {
      process.env.MAC_CONTROL_ENABLED = "true";
      process.env.MAC_CALENDAR_ENABLED = "true";
      process.env.MAC_CALENDAR_BIN_DIR = "/opt/agent/bin";
      await runMacControl({ command: "reminders" }, undefined, async (file, args) => {
        calls.push([file, ...args]);
        return JSON.stringify({ reminders: [], truncated: false });
      });
    } finally {
      process.env = saved;
    }
    expect(calls).toEqual([["/opt/agent/bin/agent-calendar-run", "reminders"]]);
  });

  test("прокладка ищет помощника соседом и молчит в stderr", async () => {
    // stderr помощника разбирается построчно: лишняя строка от прокладки
    // превратила бы понятный код в native_command_failed.
    const src = await Bun.file(new URL("../mac-daemon/calendar-spawn.c", import.meta.url)).text();
    expect(src).toContain("responsibility_spawnattrs_setdisclaim");
    expect(src).toContain('static const char HELPER[] = "agent-calendar";');
    expect(src).not.toContain("fprintf");
    expect(src).not.toContain("printf");
  });

  test("MAC_APPS must be well-formed", () => {
    expect(() => parseMacApps("notes=com.apple.Notes=x")).toThrow("apps_not_configured");
    expect(() => parseMacApps("Notes=com.apple.Notes")).toThrow("apps_not_configured");
    expect(parseMacApps(undefined).size).toBe(0);
  });
});

describe("daemon protocol", () => {
  test("control frame is parsed strictly", () => {
    const frame = (o: unknown) => parseBridgeMsg(JSON.stringify(o));
    expect(frame({ type: "control", id: "r1", control: { command: "lock" } })).toEqual({ type: "control", id: "r1", control: { command: "lock" } });
    expect(frame({ type: "control", id: "r1", control: { command: "lock", shell: "x" } })).toBeNull();
    expect(frame({ type: "control", id: "x".repeat(101), control: { command: "lock" } })).toBeNull();
    expect(frame({ type: "control", control: { command: "lock" } })).toBeNull();
  });
});

describe("handler and bridge", () => {
  const bridge = (sent: unknown[], reply = { ok: true, stdout: '{"done":"lock"}' }) => ({
    isMacConnected: () => true,
    sendToMac: async () => { throw new Error("unused"); },
    stopMac: async () => ({ ok: true }),
    isUserAllowed: (u: string | undefined | null) => u === "42",
    sendControlToMac: async (c: unknown) => { sent.push(c); return reply; },
  });

  test("strips internal fields and sends only the parsed command", async () => {
    const sent: unknown[] = [];
    const r = await handleMacControl({ command: "lock", _userId: "42", _delegated: false }, { agentKey: "orchestrator", chatId: 42, macBridge: bridge(sent) });
    expect(r).toEqual({ ok: true, result: { done: "lock" } });
    expect(sent).toEqual([{ command: "lock" }]);
  });

  test("unknown user and stale times never reach the Mac", async () => {
    const sent: unknown[] = [];
    const ctx = { agentKey: "orchestrator", chatId: 7, macBridge: bridge(sent) };
    expect(await handleMacControl({ command: "lock", _userId: "7" }, ctx)).toEqual({ ok: false, error: "forbidden" });
    const stale = await handleMacControl({ command: "reminder_add", title: "x", dueAt: Date.now() - HOUR, _userId: "42" }, ctx);
    expect(stale.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("timeout is reported as a possible side effect", async () => {
    const macBridge = { ...bridge([]), sendControlToMac: async () => { throw new Error("mac_timeout"); } };
    expect(await handleMacControl({ command: "event_add", title: "x", startAt: future(1), endAt: future(2), _userId: "42" }, { agentKey: "orchestrator", chatId: 42, macBridge }))
      .toEqual({ ok: false, error: "mac_timeout", sideEffect: true });
  });

  test("real bridge refuses group chats and missing users", async () => {
    await expect(sendControlToMac({ command: "lock" }, undefined, 42)).rejects.toThrow("forbidden");
    await expect(sendControlToMac({ command: "lock" }, "42", -100_42)).rejects.toThrow("forbidden");
  });

  test("approval card describes the command and the policy", () => {
    expect(approvalPreview("MAC_CONTROL", { command: "shutdown", _userId: "42" })).toContain("ВЫКЛЮЧИТЬ Mac");
    expect(approvalPreview("MAC_CONTROL", { command: "shutdown" })).toContain("выключение или перезагрузка");
  });
});

test("parseMacReminders caps the list", () => {
  const many = { reminders: Array.from({ length: 41 }, () => ({ title: "x", due: null })), truncated: true };
  expect(() => parseMacReminders(JSON.stringify(many))).toThrow();
});
