/**
 * Аудит 2026-08-29: третья точка входа так и писала чужой текст в журнал.
 *
 * `orchestrator-bot.ts` логировал `from=${ctx.from?.username ?? ctx.from?.id}`
 * и `text=${text.slice(0, 80)}` на уровне info. Восемьдесят символов — это
 * практически всё сообщение целиком: медиана запроса в рабочий чат короче.
 * Плюс имя пользователя рядом, то есть связка «кто именно что написал»
 * ложится в journalctl VPS открытым текстом.
 *
 * Это тот же класс, что закрыли в orchestrator-userbot.ts (PR #822), только
 * одной точкой входа левее. Заметка .claude/memory/notes/pii-data-flow-2026-05-28.md
 * при этом уже пять аудитов утверждала, что redactText «wired in
 * orchestrator-bot.ts» — из-за этой строки находку дважды считали закрытой.
 *
 * Файл проверяется только по исходнику: `bot.launch()` вызывается на уровне
 * модуля, а до него `process.exit(1)` без TELEGRAM_BOT_TOKEN. Импортировать
 * его в тесте нельзя — он полезет в Telegram или убьёт прогон.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSender, redactText } from "../lib/log.ts";

const AGENT_DIR = join(import.meta.dir, "..");

function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

const BOT = codeLines(readFileSync(join(AGENT_DIR, "orchestrator-bot.ts"), "utf-8"));
const has = (needle: string) => BOT.some((l) => l.includes(needle));
const linesWith = (needle: string) => BOT.filter((l) => l.includes(needle));

describe("предпосылки: чем именно затыкаем", () => {
  test("redactText не отдаёт середину сообщения", () => {
    const out = redactText("совершенно секретное сообщение целиком");
    expect(out).toMatch(/^<len=\d+ first4=.{4} last4=.{4}>$/);
    expect(out).not.toContain("секретное");
  });

  test("redactSender предпочитает id имени", () => {
    expect(redactSender(123456789, "vasya")).toBe("uid:6789");
    expect(redactSender(undefined, "vasya")).toStartWith("name:");
    expect(redactSender(undefined, undefined)).toBe("unknown");
  });

  test("восемьдесят символов — это почти всё сообщение, а не намёк на него", () => {
    // Сам смысл находки: `.slice(0, 80)` не является редактированием.
    const typical = "Подготовь план релиза на следующую неделю и скинь в канал";
    expect(typical.length).toBeLessThan(80);
    expect(typical.slice(0, 80)).toBe(typical);
  });
});

describe("orchestrator-bot.ts не пишет чужой текст целиком", () => {
  test("входящее сообщение уходит в журнал через redactText", () => {
    const inLine = linesWith("[in]");
    expect(inLine.length).toBe(1);
    expect(inLine[0]).toContain("redactText(text)");
  });

  test("исходящий ответ уходит в журнал через redactText", () => {
    const outLine = linesWith("[out]");
    expect(outLine.length).toBe(1);
    expect(outLine[0]).toContain("redactText(reply)");
  });

  test("отправитель уходит через redactSender, а не именем", () => {
    const inLine = linesWith("[in]");
    expect(inLine[0]).toContain("redactSender(ctx.from?.id, ctx.from?.username)");
    expect(inLine[0]).not.toContain("ctx.from?.username ??");
  });

  test("обрезки slice(0, 80) в журнальных строках не осталось", () => {
    expect(linesWith(".slice(0, 80)")).toEqual([]);
  });

  test("редакторы действительно импортированы", () => {
    expect(has("redactSender")).toBe(true);
    expect(has("redactText")).toBe(true);
    const imp = linesWith('from "./lib/log.ts"');
    expect(imp.length).toBe(1);
    expect(imp[0]).toContain("redactText");
    expect(imp[0]).toContain("redactSender");
  });
});

describe("применение ко всем точкам входа", () => {
  test("ни один orchestrator-*.ts не логирует text= сырым", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(AGENT_DIR)) {
      if (!/^orchestrator-.*\.ts$/.test(name)) continue;
      if (!statSync(join(AGENT_DIR, name)).isFile()) continue;
      for (const l of codeLines(readFileSync(join(AGENT_DIR, name), "utf-8"))) {
        if (!l.includes("text=$")) continue;
        if (l.includes("redactText(")) continue;
        offenders.push(`${name}: ${l.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
