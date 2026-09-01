/**
 * One-shot: проверяет ТУЛ-ВЫЗОВ через Agent SDK (подписка), не только текст.
 * Даёт copy-агенту mock-telegram и просит вызвать SEND_MESSAGE. Успех = mock
 * получил sendMessage с нужным текстом И runViaAgentSdk вернул непустой текст.
 *
 * Запуск (чистое окружение, подписка):
 *   unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY
 *   export CLAUDE_CODE_OAUTH_TOKEN=... CLAUDE_BIN=... USE_AGENT_SDK=true
 *   bun tools/probe-agentsdk-toolcall.ts
 */
import { runViaAgentSdk } from "../lib/agent-sdk-runtime.ts";

const calls: { chatId: any; text: string }[] = [];
const mockTelegram: any = {
  async sendMessage(chatId: any, text: string) {
    calls.push({ chatId, text });
    return { message_id: 9999, chat: { id: chatId }, text };
  },
};

const MARKER = "PROBE_TC_OK_4242";

const sys = [
  { type: "text" as const, text: "Ты — копирайтер команды. Выполняй инструкции точно и без лишних вопросов." },
];

const out = await runViaAgentSdk({
  anthropic: null as any,
  model: "claude-sonnet-4-6",
  system: sys,
  messages: [
    {
      role: "user",
      content:
        `Вызови инструмент SEND_MESSAGE с параметром text равным строго "${MARKER}". ` +
        `Ничего не спрашивай, просто вызови инструмент один раз, затем коротко подтверди.`,
    },
  ],
  agentKey: "copy",
  chatId: -1003833455524,
  botId: 1,
  telegram: mockTelegram,
  allowedTools: ["SEND_MESSAGE"],
});

console.log("=== RESULT TEXT ===");
console.log(out);
console.log("=== TELEGRAM CALLS ===");
console.log(JSON.stringify(calls, null, 2));
const hit = calls.find((c) => c.text.includes(MARKER));
console.log(hit ? "TOOLCALL_PROBE: PASS" : "TOOLCALL_PROBE: FAIL");
process.exit(hit ? 0 : 1);
