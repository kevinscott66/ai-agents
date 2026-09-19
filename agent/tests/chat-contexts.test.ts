import { describe, test, expect, afterEach } from 'bun:test';
import type { Context } from 'telegraf';
import { db } from '../lib/db.ts';
import { recordMessage, getRecentMessages } from '../lib/memory.ts';
import { handleAssistantCommand } from '../lib/assistant-commands.ts';
import {
  activeContextId, createContext, listContexts, switchContext, parseContextCommand,
  MAX_CONTEXTS_PER_CHAT,
} from '../lib/chat-contexts.ts';
import { gcMessages } from '../lib/db-maint.ts';

const CHAT = '-100777000111';
const OTHER = '-100777000222';

function cleanup() {
  for (const chat of [CHAT, OTHER]) {
    db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chat);
    db.prepare(`DELETE FROM messages_archive WHERE chat_id = ?`).run(chat);
    db.prepare(`DELETE FROM chat_contexts WHERE chat_id = ?`).run(chat);
    db.prepare(`DELETE FROM chat_active_context WHERE chat_id = ?`).run(chat);
  }
}
afterEach(cleanup);

const say = (text: string, isBot = false, chatId = CHAT) =>
  recordMessage({ chatId, agentKey: isBot ? 'orchestrator' : null, isBot, fromUserId: '1', fromName: 'u', text });
const texts = (chatId = CHAT) => getRecentMessages(chatId, 50).map((r) => r.text);

function group(chatId = CHAT) {
  const replies: string[] = [];
  const ctx = { chat: { id: Number(chatId), type: 'supergroup' }, from: { id: 5, is_bot: false },
    reply: async (t: string) => { replies.push(t); } } as unknown as Context;
  return { ctx, replies };
}

describe('контексты Telegram-чата', () => {
  test('разбор команд: регистр названия сохраняется, @бот в группе срезается', () => {
    expect(parseContextCommand('/new Отпуск в Мае')).toEqual({ kind: 'new', title: 'Отпуск в Мае' });
    expect(parseContextCommand('/new@team_lead_bot')).toEqual({ kind: 'new', title: '' });
    expect(parseContextCommand('/chats')).toEqual({ kind: 'list' });
    expect(parseContextCommand('/switch@team_lead_bot 2')).toEqual({ kind: 'switch', target: '2' });
    expect(parseContextCommand('/chats лишнее')).toBeNull();
    expect(parseContextCommand('/newest')).toBeNull();
    expect(parseContextCommand('объясни, что делает /new')).toBeNull();
  });

  test('/new начинает чистую историю, /switch возвращает прежнюю целиком', () => {
    say('старый вопрос'); say('старый ответ', true);
    const r = createContext(CHAT);
    expect(r.ok).toBe(true);
    expect(texts()).toEqual([]);
    say('новая тема'); say('ответ по новой теме', true);
    expect(texts()).toEqual(['новая тема', 'ответ по новой теме']);

    expect(switchContext(CHAT, '1')!.title).toBe('Основной');
    expect(texts()).toEqual(['старый вопрос', 'старый ответ']);
    expect(switchContext(CHAT, '2')!.title).toBe('новая тема');
    expect(texts()).toEqual(['новая тема', 'ответ по новой теме']);
  });

  test('контекст — свойство чата: соседний чат его не видит', () => {
    say('чужое', false, OTHER);
    createContext(CHAT, 'Моё');
    expect(activeContextId(OTHER)).toBeNull();
    expect(texts(OTHER)).toEqual(['чужое']);
    expect(switchContext(OTHER, listContexts(CHAT)[1]!.id!)).toBeNull();
  });

  test('безымянный контекст берёт название из первой реплики человека, не из команды и не от бота', () => {
    createContext(CHAT);
    say('/chats'); say('Привет от бота', true); say('Планируем релиз 0.1.28');
    say('вторая реплика');
    expect(listContexts(CHAT)[1]).toMatchObject({ number: 2, title: 'Планируем релиз 0.1.28', active: true, messages: 4 });
  });

  test('потолок контекстов на чат', () => {
    for (let i = 0; i < MAX_CONTEXTS_PER_CHAT; i++) expect(createContext(CHAT, `к${i}`).ok).toBe(true);
    expect(createContext(CHAT, 'лишний')).toEqual({ ok: false, reason: 'limit' });
    expect(listContexts(CHAT)).toHaveLength(MAX_CONTEXTS_PER_CHAT + 1);
  });

  test('команды отвечают в группе и меняют историю', async () => {
    say('до');
    const { ctx, replies } = group();
    expect(await handleAssistantCommand(ctx, '/new Бюджет')).toBe(true);
    expect(replies.at(-1)).toContain('№2 «Бюджет»');
    expect(texts()).toEqual([]);
    expect(await handleAssistantCommand(ctx, '/chats')).toBe(true);
    expect(replies.at(-1)).toContain('▶ 2. Бюджет');
    expect(replies.at(-1)).toContain('1. Основной · сообщений: 1');
    await handleAssistantCommand(ctx, '/switch 9');
    expect(replies.at(-1)).toContain('такого контекста');
    await handleAssistantCommand(ctx, '/switch');
    expect(replies.at(-1)).toContain('укажите номер');
    await handleAssistantCommand(ctx, '/switch 1');
    expect(replies.at(-1)).toContain('«Основной»');
    expect(texts()).toEqual(['до']);
  });

  test('из приложения команды контекст Telegram не трогают', async () => {
    const { ctx, replies } = group();
    await handleAssistantCommand(ctx, '/new', { source: 'native' });
    expect(replies.at(-1)).toContain('в приложении');
    expect(activeContextId(CHAT)).toBeNull();
  });

  test('архивация переносит context_id и не останавливается на новой колонке', () => {
    createContext(CHAT, 'Старое');
    const id = activeContextId(CHAT);
    recordMessage({ chatId: CHAT, agentKey: null, isBot: false, fromUserId: '1', fromName: 'u', text: 'давно', ts: 1_000 });
    // Отсечка в январе 1970-го: переносится только эта строка, чужие не трогаем.
    gcMessages({ retentionDays: 1, now: 1_000 + 2 * 86_400_000 });
    const row = db.prepare(`SELECT context_id FROM messages_archive WHERE chat_id = ? AND text = 'давно'`).get(CHAT) as { context_id: string } | undefined;
    expect(row?.context_id).toBe(id!);
  });
});
