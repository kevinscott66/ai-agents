/**
 * Дирижёр — оркестратор-агент мультиагентной команды в Telegram.
 * Этап 1: одиночный character на Bot API + Claude.
 */

import { AgentRuntime, createCharacter } from "@elizaos/core";
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import sqlPlugin from "@elizaos/plugin-sql";
import telegramPlugin from "@elizaos/plugin-telegram";

async function main() {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!anthropicApiKey || !telegramBotToken) {
    console.error("Missing ANTHROPIC_API_KEY or TELEGRAM_BOT_TOKEN in env");
    process.exit(1);
  }

  const character = createCharacter({
    name: "Дирижёр",
    bio: "Оркестратор мультиагентной команды. Принимает запросы пользователя, ставит задачи специализированным агентам, контролирует исполнение и отчитывается результатом.",
    system: `Ты — Дирижёр, главный агент-оркестратор команды из 12 ИИ-специалистов в Telegram.
Команда: PM, Product, Backend Dev, Frontend Dev, Telegram Bot Dev, AI/LLM Engineer, QA, SMM, Copywriter, Designer, Action/Permissions.

Правила:
- Отвечай по-русски, кратко, по делу.
- Если запрос ясен — формулируй план и сразу скажи, кому из команды его передал бы (роль).
- Если запрос непонятен — задавай уточняющие вопросы.
- Не выдумывай статусы исполнения. На этапе 1 ты единственный агент онлайн, остальные подключатся позже.
- Тон: спокойный, уверенный, профессиональный, без воды и эмодзи.`,
    settings: {
      ANTHROPIC_SMALL_MODEL:
        process.env.ANTHROPIC_SMALL_MODEL ?? "claude-haiku-4-5-20251001",
      ANTHROPIC_LARGE_MODEL:
        process.env.ANTHROPIC_LARGE_MODEL ?? "claude-sonnet-4-6",
      TELEGRAM_AUTO_REPLY: "true",
    },
    secrets: {
      ANTHROPIC_API_KEY: anthropicApiKey,
      TELEGRAM_BOT_TOKEN: telegramBotToken,
    },
  });

  console.log(`Запускаю агента: ${character.name}`);

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, anthropicPlugin, telegramPlugin],
  });

  await runtime.initialize();

  console.log(`${character.name} работает. Ctrl+C — остановить.`);

  process.on("SIGINT", async () => {
    console.log("\nОстанавливаю агента...");
    await runtime.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
