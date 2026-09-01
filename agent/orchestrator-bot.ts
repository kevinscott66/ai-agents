/**
 * Дирижёр — Bot API режим (telegraf + Anthropic SDK напрямую).
 * Этап 1: bare-bones smoke test без eliza-runtime.
 * Eliza-память/actions/plugins подключим, когда базовый цикл будет стабильно работать.
 */
import { Telegraf } from "telegraf";
import Anthropic from "@anthropic-ai/sdk";
import { callAnthropic } from "./lib/anthropic-client.ts";
import { runTextViaAgentSdk, useAgentSdk } from "./lib/agent-sdk-runtime.ts";
import { describeAllowlist, isAllowlisted } from "./lib/allowlist.ts";
import { BudgetExceededError } from "./lib/token-budget.ts";
import { log, redactSender, redactText } from "./lib/log.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const SUBSCRIPTION_MODE = useAgentSdk();
const CLAUDE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
const MODEL = process.env.ANTHROPIC_LARGE_MODEL?.trim() || "claude-sonnet-4-6";
const ALLOWED = (process.env.TELEGRAM_ALLOWED_GROUP_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (
  !BOT_TOKEN ||
  (SUBSCRIPTION_MODE && !CLAUDE_OAUTH_TOKEN) ||
  (!SUBSCRIPTION_MODE && !ANTHROPIC_API_KEY)
) {
  log.error("Need TELEGRAM_BOT_TOKEN and Claude subscription or Anthropic API credentials");
  process.exit(1);
}

const SYSTEM_PROMPT = `Ты — Дирижёр, главный агент-оркестратор команды из 12 ИИ-специалистов в Telegram.
Команда: PM, Product, Backend Dev, Frontend Dev, Telegram Bot Dev, AI/LLM Engineer, QA, SMM, Copywriter, Designer, Action/Permissions.

Правила:
- Отвечай по-русски, кратко, по делу.
- Если запрос ясен — формулируй план и сразу скажи, кому из команды его передал бы (роль).
- Если запрос непонятен — задавай уточняющие вопросы.
- На этапе 1 ты единственный агент онлайн, остальные подключатся позже.
- Тон: спокойный, уверенный, профессиональный, без воды и эмодзи.`;

const bot = new Telegraf(BOT_TOKEN);

bot.on("message", async (ctx) => {
  try {
    const chatId = ctx.chat.id.toString();
    if (!isAllowlisted(chatId, ALLOWED)) {
      log.info(`[skip] chat=${chatId} not in allowlist`);
      return;
    }
    const msg: any = ctx.message;
    const text: string = msg.text ?? msg.caption ?? "";
    if (!text.trim()) return;
    // Аудит 2026-08-29: здесь стояли `from=<username>` и `text=<первые 80>`.
    // Восемьдесят символов — это типичное сообщение целиком, а имя рядом даёт
    // связку «кто именно что написал» открытым текстом в journalctl. Боевой
    // путь давно пишет так же, как ниже (orchestrator/message-handler.ts),
    // и orchestrator-userbot.ts привели к этому же виду в PR #822.
    log.info(
      `[in] chat=${chatId} from=${redactSender(ctx.from?.id, ctx.from?.username)} text=${redactText(text)}`,
    );

    await ctx.sendChatAction("typing");
    const reply = SUBSCRIPTION_MODE
      ? await runTextViaAgentSdk({
          system: SYSTEM_PROMPT,
          prompt: text,
          maxTurns: 1,
          model: process.env.ANTHROPIC_LARGE_MODEL_SDK?.trim() || "sonnet",
          agentKey: "orchestrator",
        })
      : (await callAnthropic(
          {
            model: MODEL,
            max_tokens: 512,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: text }],
          },
          undefined,
          "orchestrator",
        )).content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
    if (!reply) return;
    await ctx.reply(reply, { reply_parameters: { message_id: ctx.message.message_id } });
    log.info(`[out] chat=${chatId} text=${redactText(reply)}`);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.info(`[budget] swallow: ${err.message}`);
      return;
    }
    log.error("Error", { error: (err as Error)?.message, stack: (err as Error)?.stack });
  }
});

log.info(`Дирижёр (Bot API) стартует. Allowed: ${describeAllowlist(ALLOWED)}`);
bot.launch({ dropPendingUpdates: true });
bot.telegram.getMe().then((me) => log.info(`Бот @${me.username} (id=${me.id}) в эфире`));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
