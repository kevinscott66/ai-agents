/**
 * Прогон: для каждого саб-бота из CHARACTERS строим Telegraf-клиент (без launch),
 * выгребаем контекст из памяти, дёргаем Claude от его имени и публикуем ответ в чат.
 * Аналог `respondAs()` из lib/handoff.ts, но запускается отдельно — для теста.
 *
 * Аудит 2026-09-11, круг 51: здесь было сказано «из orchestrator-team.ts».
 * Файл такой есть, но `respondAs` в нём нет и давно не было — функция живёт в
 * lib/handoff.ts. Имя в обратных кавычках — обещание, что символ найдётся по
 * этому адресу; искавший сравнить две редакции не нашёл бы ничего.
 */
import { Telegraf } from "telegraf";
import type Anthropic from "@anthropic-ai/sdk";
import { CHARACTERS, type CharacterDef } from "../characters/index.ts";
import { createAnthropic } from "../lib/anthropic-client.ts";
import {
  recordMessage,
  getRecentMessages,
  wikiIndex,
  wikiLog,
  wikiSearch,
  wikiRead,
} from "../lib/memory.ts";

const CHAT_ID = process.argv[2];
const TRIGGER =
  process.argv.slice(3).join(" ") ||
  "Команда, короткий статус по своей зоне: что готов сделать в первой итерации MVP бота-бронирования столиков в сети кафе. До 200 слов.";

if (!CHAT_ID) {
  console.error("usage: bun tools/test-handoff.ts <chat_id> [trigger text]");
  process.exit(1);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = process.env.ANTHROPIC_LARGE_MODEL?.trim() || "claude-sonnet-4-6";
const HISTORY_LIMIT = Number(process.env.MEMORY_HISTORY_LIMIT ?? 30);
// Тот же клиент, что и в проде: ретраи SDK выключены, ретраит callAnthropic.
const anthropic = createAnthropic(ANTHROPIC_API_KEY);

const TG_LIMIT = 4000;
function splitForTelegram(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = "";
  const flush = () => { if (buf.trim()) out.push(buf.trimEnd()); buf = ""; };
  const push = (c: string) => { if ((buf + c).length > limit) flush(); buf += c; };
  for (const p of text.split(/\n\n+/)) {
    if (p.length <= limit) push((buf ? "\n\n" : "") + p);
    else {
      flush();
      for (const line of p.split("\n")) {
        if (line.length <= limit) push((buf ? "\n" : "") + line);
        else { flush(); for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit)); }
      }
    }
  }
  flush();
  return out;
}

async function respondAs(def: CharacterDef, bot: Telegraf, botId: number, botUsername: string) {
  console.log(`[${def.key}] thinking…`);
  const recent = getRecentMessages(CHAT_ID, HISTORY_LIMIT);
  const teamIdx = wikiIndex("_team");
  const teamLog = wikiLog("_team").split("\n").slice(-30).join("\n");
  const privIdx = wikiIndex(def.key);
  const hits = wikiSearch(TRIGGER, ["_team", def.key], 4);
  const hitPages = hits
    .map((h) => `### ${h.scope}/${h.slug}\n${(wikiRead(h.scope, h.slug) ?? "").slice(0, 1200)}`)
    .join("\n\n");

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: def.system, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text:
        `=== ОБЩИЙ ИНДЕКС КОМАНДЫ ===\n${teamIdx}\n\n` +
        `=== ЛИЧНЫЙ ИНДЕКС (${def.key}) ===\n${privIdx}\n\n` +
        `=== ПОСЛЕДНИЕ ЗАПИСИ В ОБЩЕМ ЛОГЕ ===\n${teamLog}`,
      cache_control: { type: "ephemeral" },
    },
    ...(hitPages ? [{ type: "text" as const, text: `=== РЕЛЕВАНТНЫЕ СТРАНИЦЫ ===\n${hitPages}` }] : []),
  ];

  const messages: Anthropic.MessageParam[] = recent.map((r) => ({
    role: r.is_bot && r.agent_key === def.key ? "assistant" : "user",
    content: r.is_bot && r.agent_key === def.key
      ? r.text
      : `[${r.agent_key ?? r.from_name ?? "user"}] ${r.text}`,
  }));
  messages.push({ role: "user", content: `[orchestrator] (handoff) ${TRIGGER}` });

  const completion = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 700,
    system,
    messages,
  });
  const reply = completion.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text).join("\n").trim();
  if (!reply) {
    console.warn(`[${def.key}] empty reply`);
    return;
  }
  const parts = splitForTelegram(reply);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `(${i + 1}/${parts.length}) ` : "";
    const sent = await bot.telegram.sendMessage(CHAT_ID, prefix + parts[i]);
    recordMessage({
      chatId: CHAT_ID,
      agentKey: def.key,
      isBot: true,
      fromUserId: botId.toString(),
      fromName: botUsername,
      text: prefix + parts[i],
      ts: (sent.date ?? Math.floor(Date.now() / 1000)) * 1000,
    });
  }
  console.log(`[${def.key}] sent ${reply.length} chars in ${parts.length} part(s)`);
}

async function main() {
  for (const def of CHARACTERS) {
    if (def.key === "orchestrator") continue;
    const token = process.env[def.envToken];
    if (!token) {
      console.log(`[${def.key}] no token, skip`);
      continue;
    }
    const bot = new Telegraf(token);
    let me: any;
    try {
      me = await bot.telegram.getMe();
    } catch (e: any) {
      console.warn(`[${def.key}] getMe failed: ${e?.message}`);
      continue;
    }
    try {
      await respondAs(def, bot, me.id, me.username ?? "");
    } catch (e: any) {
      console.error(`[${def.key}] ERROR:`, e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 1500)); // антифлуд
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
