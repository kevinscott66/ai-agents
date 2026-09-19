import { test, expect } from 'bun:test';
import { WHOLE_MESSAGE_FITS, sendChunked } from '../lib/telegram-chunking.ts';
import { nativeTurnContext } from '../lib/native-context.ts';
import { handleSendMessage } from '../lib/dispatch/telegram.ts';
import { NativeAccess, NATIVE_REPLY_MAX, NATIVE_TURN_REPLIES_BYTES, clipReply } from '../lib/native-access.ts';

const long = Array.from({ length: 30 }, (_, i) => `Абзац ${i + 1}. ` + 'слово '.repeat(40)).join('\n\n');

test('the app gets one message where Telegram gets parts', async () => {
  expect(long.length).toBeGreaterThan(4096);
  const telegram: string[] = []; await sendChunked(async t => { telegram.push(t); return {}; }, long);
  expect(telegram.length).toBeGreaterThan(1);
  expect(telegram[0]).toStartWith('(1/');
  const app: string[] = []; const parts: number[] = [];
  await sendChunked(async t => { app.push(t); return { message_id: 1 }; }, long, (_s, _p, i, total) => parts.push(i, total), WHOLE_MESSAGE_FITS);
  expect(app).toEqual([long]); expect(parts).toEqual([0, 1]);
  await expect(sendChunked(async () => ({}), '  ', undefined, WHOLE_MESSAGE_FITS)).rejects.toThrow();
});

test('SEND_MESSAGE inside an app turn goes out whole, as Markdown', async () => {
  const sent: string[] = [];
  const tg = { sendMessage: async (_chat: string, text: string, extra?: unknown) => { expect(extra).toBeUndefined(); sent.push(text); return { message_id: -1 }; } };
  const result = await nativeTurnContext.run({ userId: '42', turnId: 't', conversationId: 'c', linkApproval: () => {} },
    () => handleSendMessage({ chatId: '42', text: '**Итог**\n\n' + long } as never, { chatId: '42', agentKey: 'orchestrator', telegram: tg } as never));
  expect(result.ok).toBe(true);
  expect(sent).toEqual(['**Итог**\n\n' + long]);
});

test('a long app reply is stored whole', () => {
  const s = new NativeAccess(':memory:');
  try {
    s.createConversation('dialog-0000000001', '1', 'One');
    s.start('turn-000000000001', 'd', '1', 'hi', 'dialog-0000000001');
    s.append('turn-000000000001', long);
    expect(s.history('dialog-0000000001', '1')!.messages.at(-1)!.text).toBe(long);
    s.append('turn-000000000001', 'x'.repeat(NATIVE_REPLY_MAX + 10));
    expect(s.history('dialog-0000000001', '1')!.messages.at(-1)!.text).toHaveLength(NATIVE_REPLY_MAX);
  } finally { s.db.close(); }
});

test('reply limits match the iPhone: UTF-16 length, whole emoji, whole turn fits the response', () => {
  const emoji = '😀'.repeat(NATIVE_REPLY_MAX); // 64000 UTF-16 units
  const clipped = clipReply(emoji);
  expect(clipped.length).toBe(NATIVE_REPLY_MAX);
  expect(clipReply('a' + emoji).length).toBe(NATIVE_REPLY_MAX - 1); // не рвём пару
  expect(clipReply('a' + emoji).isWellFormed()).toBe(true);
  const s = new NativeAccess(':memory:');
  try {
    s.createConversation('dialog-0000000001', '1', 'One');
    s.start('turn-000000000001', 'd', '1', 'hi', 'dialog-0000000001');
    for (const n of [8000, 8001, NATIVE_REPLY_MAX]) s.append('turn-000000000001', 'б'.repeat(n));
    s.append('turn-000000000001', 'a' + emoji);
    let replies = s.get('turn-000000000001', 'd')!.replies;
    expect(replies.map(r => r.length)).toEqual([8000, 8001, NATIVE_REPLY_MAX, NATIVE_REPLY_MAX - 1]);
    expect(replies.every(r => r.isWellFormed())).toBe(true);
    for (let i = 0; i < 76; i++) s.append('turn-000000000001', '日'.repeat(NATIVE_REPLY_MAX));
    replies = s.get('turn-000000000001', 'd')!.replies;
    expect(replies.length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(JSON.stringify(replies))).toBeLessThanOrEqual(NATIVE_TURN_REPLIES_BYTES);
    expect(replies.every(r => r.length <= NATIVE_REPLY_MAX && r.isWellFormed())).toBe(true);
  } finally { s.db.close(); }
});
