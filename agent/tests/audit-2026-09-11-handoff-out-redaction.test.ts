/**
 * Аудит 2026-09-11: ответ делегата уезжал в journalctl открытым текстом.
 *
 * Прямой путь режет обе стороны разговора: `[in]`/`[raw]` — с аудита
 * 2026-08-12, `[out]` — с формулировкой «ответ агента это пересказ переписки:
 * тот же приватный контент, что и вход, только уже собранный. Симметрично со
 * строкой [in]» (orchestrator/message-handler.ts). Каскад по упоминаниям
 * публикует ответ ДРУГИМ ботом — через `respondAs` в lib/handoff.ts, — и там
 * стояли первые 80 символов ответа как есть.
 *
 * Восемьдесят символов это типичное сообщение целиком (так и сказано в
 * аудите 2026-08-29 про ту же строку у orchestrator-bot). Уровень info, то
 * есть прод; строка пишется на КАЖДЫЙ хоп каскада. Глобальный скраббер
 * `scrubSecrets` тут не помогает: он снимает значения секретов по известным
 * образцам, а не текст переписки.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { redactText } from "../lib/log.ts";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const HANDOFF = src("../lib/handoff.ts");
const HANDLER = src("../orchestrator/message-handler.ts");

/** Только код: докблоки ниже цитируют исправленное и ломали бы проверки. */
function codeLines(s: string): string[] {
  return s.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

describe("предпосылка: redactText не показывает середину", () => {
  test("длинный ответ сводится к длине и краям", () => {
    const reply = "Ключ от прода лежит в 1Password, спроси у Кости, вот ссылка";
    const out = redactText(reply);
    expect(out).not.toContain("1Password");
    expect(out).not.toContain("Кости");
    expect(out).toContain(`len=${reply.length}`);
  });

  test("короткий ответ — только длина", () => {
    expect(redactText("да")).toBe("<len=2>");
  });
});

describe("строка [handoff-out]", () => {
  const line = codeLines(HANDOFF).find((l) => l.includes("[handoff-out]"));

  test("строка на месте", () => {
    expect(line).toBeDefined();
  });

  test("текст ответа режется, а не печатается", () => {
    expect(line!).toContain("redactText(reply)");
    expect(line!).not.toContain("reply.slice");
  });

  test("сырых первых 80 символов в файле не осталось нигде", () => {
    const hits = codeLines(HANDOFF).filter((l) => /\.slice\(0,\s*80\)/.test(l));
    expect(hits).toEqual([]);
  });

  test("режет тем же примитивом, что и прямой путь", () => {
    const direct = codeLines(HANDLER).find((l) =>
      l.includes("`[out][${def.key}] chat="),
    );
    expect(direct).toBeDefined();
    expect(direct!).toContain("redactText(reply)");
  });

  test("примитив импортирован из общего модуля логов", () => {
    expect(HANDOFF).toMatch(/import \{[^}]*redactText[^}]*\} from "\.\/log\.ts"/);
  });
});
