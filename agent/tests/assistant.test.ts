import { describe, test, expect, afterEach } from 'bun:test';
import type { Context } from 'telegraf';
import { parseAssistantCommand, handleAssistantCommand, prioritizeTasks, formatCalendar } from '../lib/assistant-commands.ts';
import { parseCalendarDay } from '../lib/assistant-types.ts';
import { runAssistantOperation, nativeExec, assistantErrorCode } from '../mac-daemon/assistant.ts';
import { parseBridgeMsg } from '../mac-daemon/protocol.ts';
import { createAuthGate } from '../mac-daemon/auth-gate.ts';
import { sendAssistantToMac, _setActiveSocketForTests, _handleClientMessageForTests } from '../lib/mac-bridge.ts';
import type { Task } from '../lib/tasks.ts';
import { cleanupChat } from './_helpers.ts';

const day = { date: '2026-09-15', timeZone: 'Europe/Moscow', truncated: false, events: [
  { title: 'Планирование', start: '2026-09-15T07:00:00Z', end: '2026-09-15T08:00:00Z', allDay: false },
  { title: 'Созвон', start: '2026-09-15T07:30:00Z', end: '2026-09-15T09:00:00Z', allDay: false },
] };
const owner = 999321011;
afterEach(() => { cleanupChat(owner); cleanupChat(-owner); _setActiveSocketForTests(null); });
function context(privateChat = true) {
  const replies: string[] = [];
  const ctx = { chat: { id: privateChat ? owner : -owner, type: privateChat ? 'private' : 'supergroup' },
    from: { id: owner, is_bot: false }, reply: async (text: string) => { replies.push(text); } } as unknown as Context;
  return { ctx, replies };
}
const task = (id: string, priority: number, deadline: number | null, status = 'pending') =>
  ({ id, title: id, priority, deadline, status, created_at: 1 } as Task);

describe('Агент: personal daily workflow', () => {
  test('explicit commands only; no substring execution', () => {
    expect(parseAssistantCommand('Агент, начни мой день!')).toBe('morning');
    expect(parseAssistantCommand('Агент: покажи календарь')).toBe('calendar');
    expect(parseAssistantCommand('Объясни команду «открой рабочие приложения»')).toBeNull();
  });
  test('overdue wins; completed tasks excluded; no mutation', () => {
    const tasks = [task('high', 100, null), task('late', 1, 5), task('done', 100, 1, 'done')];
    expect(prioritizeTasks(tasks, 10).map(t => t.id)).toEqual(['late', 'high']);
    expect(tasks[0].id).toBe('high');
  });
  test('Mac timezone and overlap; malformed calendar rejected', () => {
    const text = formatCalendar(parseCalendarDay(JSON.stringify(day)));
    expect(text).toContain('10:00–11:00');
    expect(text).toContain('Пересечений по времени: 1');
    expect(() => parseCalendarDay(JSON.stringify({ ...day, timeZone: 'Invalid' }))).toThrow();
    expect(() => parseCalendarDay(JSON.stringify({ ...day, events: [{ title: 'broken' }] }))).toThrow();
  });
  test('group morning never reads private calendar, tasks stay chat-scoped', async () => {
    const { ctx, replies } = context(false);
    let reads = 0, queried: unknown;
    await handleAssistantCommand(ctx, 'Агент, начни мой день', {}, {
      tasks: ((chat: unknown) => { queried = chat; return []; }) as any,
      online: () => true, allowed: () => true,
      mac: async () => { reads++; throw new Error('must not execute'); },
    });
    expect(reads).toBe(0); expect(queried).toBe(-owner);
    expect(replies[0]).toContain('Личный календарь');
  });
  test('owner DM returns live calendar and no automatic workspace mutation', async () => {
    const { ctx, replies } = context();
    const operations: string[] = [];
    await handleAssistantCommand(ctx, 'Агент, начни мой день', {}, {
      tasks: () => [], online: () => true, allowed: () => true,
      mac: async op => { operations.push(op); return { ok: true, stdout: JSON.stringify(day), stderr: '' }; },
    });
    expect(operations).toEqual(['calendar_today']); expect(replies[0]).toContain('Планирование');
  });
  test('offline calendar is distinct from an empty calendar', async () => {
    const { ctx, replies } = context();
    await handleAssistantCommand(ctx, '/calendar', {}, {
      tasks: () => [], online: () => false, allowed: () => true,
      mac: async () => { throw new Error('mac_offline'); },
    });
    expect(replies[0]).toContain('недоступен'); expect(replies[0]).not.toContain('Событий на сегодня нет');
  });
  test('native module is opt-in; remote command cannot supply a shell or app', async () => {
    let calls = 0;
    const exec = async () => { calls++; return ''; };
    await expect(runAssistantOperation('calendar_today', {}, exec)).rejects.toThrow('calendar_disabled');
    await expect(runAssistantOperation('open_workspace', { MAC_WORKSPACE_APPS: 'com.apple.Calendar;touch /tmp/pwn' }, exec)).rejects.toThrow();
    expect(calls).toBe(0);
    const args: string[][] = [];
    await runAssistantOperation('open_workspace', { MAC_WORKSPACE_APPS: 'com.apple.Calendar,com.apple.Notes' }, async (file, a) => { args.push([file, ...a]); return ''; });
    expect(args).toEqual([['/usr/bin/open', '-b', 'com.apple.Calendar'], ['/usr/bin/open', '-b', 'com.apple.Notes']]);
  });
  test('assistant protocol requires auth and rejects unknown operations', () => {
    expect(parseBridgeMsg(JSON.stringify({ type: 'assistant', id: 'x', operation: 'shell' }))).toBeNull();
    const msg = parseBridgeMsg(JSON.stringify({ type: 'assistant', id: 'x', operation: 'calendar_today' }));
    const gate = createAuthGate(); expect(gate.accepts(msg)).toBe(false);
    gate.markAuthenticated(); expect(gate.accepts(msg)).toBe(true);
  });
  test('bridge personal request authorization and result round trip', async () => {
    const before = process.env.MAC_USER_IDS;
    process.env.MAC_USER_IDS = String(owner);
    try {
      let frame: any;
      const socket = { data: { authed: true }, send: (s: string) => { frame = JSON.parse(s); return 1; } };
      _setActiveSocketForTests(socket);
      await expect(sendAssistantToMac('calendar_today', String(owner), -owner)).rejects.toThrow('forbidden');
      await expect(sendAssistantToMac('calendar_today', '5', 5)).rejects.toThrow('forbidden');
      const result = sendAssistantToMac('calendar_today', String(owner), owner);
      expect(frame.type).toBe('assistant');
      _handleClientMessageForTests(socket, JSON.stringify({ type: 'chunk', id: frame.id, stream: 'stdout', data: JSON.stringify(day) }));
      _handleClientMessageForTests(socket, JSON.stringify({ type: 'result', id: frame.id, ok: true, code: 0 }));
      expect((await result).stdout).toContain('Планирование');
    } finally { if (before === undefined) delete process.env.MAC_USER_IDS; else process.env.MAC_USER_IDS = before; }
  });
});

test('native credential cannot mint a fresh device credential', async () => {
  const {ctx, replies} = context();
  await handleAssistantCommand(ctx, '/pair_native', { source: 'native' }, {
    tasks: () => [], online: () => true, allowed: () => true,
    mac: async () => { throw new Error('must not execute'); },
  });
  expect(replies[0]).toContain('только командой /pair_native в личном Telegram-чате');
});
test('cancelling Mac workspace aborts active child and prevents remaining launches', async () => {
  const controller = new AbortController();
  const launched: string[] = [];
  const run = runAssistantOperation('open_workspace', { MAC_WORKSPACE_APPS:'com.apple.Calendar,com.apple.Notes' }, async (_file, args, signal) => {
    launched.push(args[1]);
    return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), {once:true}));
  }, controller.signal);
  controller.abort();
  await expect(run).rejects.toThrow('assistant_cancelled');
  expect(launched).toEqual(['com.apple.Calendar']);
});

test('actual native subprocess exits on cancellation', async () => {
  const controller = new AbortController();
  const result = nativeExec('/bin/sleep', ['30'], controller.signal);
  const timer = setTimeout(() => controller.abort(), 20);
  try { await expect(result).rejects.toThrow('native_command_failed'); }
  finally { clearTimeout(timer); }
}, 2000);


test('calendar permission failure is actionable and never exposes private stderr', async () => {
  expect(assistantErrorCode(new Error('calendar_access_required'))).toBe('calendar_access_required');
  expect(assistantErrorCode(new Error('private event and credential details'))).toBe('assistant_unavailable');
  const {ctx,replies}=context();
  await handleAssistantCommand(ctx,'/calendar',{}, {
    tasks:()=>[],online:()=>true,allowed:()=>true,
    mac:async()=>({ok:false,stdout:'',stderr:'',error:'calendar_access_required'}),
  });
  expect(replies[0]).toContain('Системные настройки');
  expect(replies[0]).not.toContain('Событий на сегодня нет');
});
