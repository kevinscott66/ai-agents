/**
 * Аудит 2026-08-28: ссылки на строки userbot.ts указывали не туда.
 *
 * Девять комментариев в дереве ссылались на `userbot.ts:<строка>` или
 * `orchestrator-userbot.ts:<строка>`. К этому дню все восемь номеров в
 * lib/userbot.ts указывали на пустую строку, закрывающую скобку или чужой
 * код: файл правился шесть раз за неделю, а номера в комментариях не
 * двигаются. Так комментарий в lib/telegram-chunking.ts объяснял читателю, что
 * «юзербот зовёт gramjs sendMessage», и называл строку в lib/userbot.ts, где к
 * тому дню лежала пустая строка внутри докстринга; настоящая отправка живёт в
 * `buildHandle().sendMessage`.
 *
 * Это не косметика: ровно на такой протухшей ссылке уже спотыкались —
 * `.claude/memory/notes/pii-data-flow-2026-05-28.md` (таблица «Where it's
 * redacted at egress / log») уверял, что orchestrator-userbot.ts переведён на
 * redactText, и перевод пришлось делать
 * заново два аудита спустя (PR #822). Имя символа не двигается вместе с
 * файлом, номер строки двигается всегда.
 *
 * Сторож узкий — только семейство userbot.ts. Остальное дерево цитирует
 * строки по-прежнему; запрещать это целиком здесь не место.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "data",
  "backups",
  "coverage",
  ".git",
]);

function walk(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(root, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const TREE = walk(join(import.meta.dir, ".."));
const read = (name: string) => readFileSync(join(import.meta.dir, "..", name), "utf8");

describe("ссылки на userbot.ts не привязаны к номерам строк", () => {
  test("ни одной ссылки вида userbot.ts:<строка> во всём дереве", () => {
    const bad: string[] = [];
    for (const f of TREE) {
      // Собственная шапка этого теста цитирует форму, от которой уходим.
      if (f.endsWith("audit-2026-08-28-userbot-doc-citations.test.ts")) continue;
      for (const l of readFileSync(f, "utf8").split("\n")) {
        if (/userbot\.ts:\d/.test(l)) bad.push(`${f}: ${l.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("названные вместо номеров символы действительно существуют", () => {
  const SRC = read("lib/userbot.ts");

  test("buildHandle — там, где живёт отправка от лица владельца", () => {
    expect(SRC).toContain("export function buildHandle(");
    // Сырая отправка gramjs, ради которой на неё ссылается telegram-chunking.
    expect(SRC).toContain("await client.sendMessage(peer, {");
  });

  test("makeHandler — вход ингеста, на который ссылается allowlist-сторож", () => {
    expect(SRC).toContain("export function makeHandler(");
  });

  test("publishPost — публикация, на которую ссылается эмодзи-тест", () => {
    expect(SRC).toContain("async publishPost(channelId, text, opts)");
  });

  test("подписка на NewMessage — там, где её ищут комментарии", () => {
    expect(SRC).toContain("new NewMessage({})");
  });

  test("глухой дроп своих сообщений — в обработчике orchestrator-userbot", () => {
    const lines = read("orchestrator-userbot.ts").split("\n");
    expect(lines.some((l) => l.includes("msg.out") && l.includes("return"))).toBe(true);
  });
});
