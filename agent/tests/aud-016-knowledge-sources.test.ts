/**
 * AUD-016: источники памяти — не технические id, а автор, дата, выдержка и
 * адрес сообщения (диалог + seq), в том числе из другого диалога проекта.
 */
import { test, expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';

function fixture() {
  const store = new NativeAccess(':memory:');
  const db = store.db;
  const now = Date.now();
  db.query('INSERT INTO conversations(id,user_id,title,created,updated) VALUES(?,?,?,?,?)').run('conv-aaaaaaaaaaaaaaaa', 'one', 'Дизайн', now, now);
  db.query('INSERT INTO conversations(id,user_id,title,created,updated) VALUES(?,?,?,?,?)').run('conv-bbbbbbbbbbbbbbbb', 'one', 'Релиз', now, now);
  db.query('INSERT INTO conversations(id,user_id,title,created,updated) VALUES(?,?,?,?,?)').run('conv-cccccccccccccccc', 'two', 'Чужой', now, now);
  const msg = (id: string, chat: string, role: string, text: string) =>
    db.query('INSERT INTO conversation_messages(id,conversation_id,role,text,created) VALUES(?,?,?,?,?)').run(id, chat, role, text, 1_700_000_000_000);
  msg('ma', 'conv-aaaaaaaaaaaaaaaa', 'user', 'Делаем   синюю\nтему. ' + 'x'.repeat(400));
  msg('mb', 'conv-bbbbbbbbbbbbbbbb', 'assistant', 'Релиз в пятницу');
  msg('mc', 'conv-cccccccccccccccc', 'user', 'чужое');
  db.query('INSERT INTO native_message_authors VALUES(?,?)').run('mb', 'devops');
  return store;
}

test('источник своего диалога: автор, дата, выдержка, адрес', () => {
  const store = fixture();
  const k = store.knowledge;
  k.updateChat('one', 'conv-aaaaaaaaaaaaaaaa', 0, [{ id: 'color', kind: 'decision', text: 'Синяя тема', sourceMessageIds: ['ma'] }]);
  const v = k.view('one', 'conv-aaaaaaaaaaaaaaaa');
  const s = v.sources.ma!;
  expect(s.conversationId).toBe('conv-aaaaaaaaaaaaaaaa');
  expect(s.conversationTitle).toBe('Дизайн');
  expect(s.role).toBe('user');
  expect(s.created).toBe(1_700_000_000_000);
  expect(typeof s.seq).toBe('number');
  expect(s.excerpt.startsWith('Делаем синюю тему.')).toBe(true);
  expect(s.excerpt.length).toBe(240);
  expect(s.excerpt.endsWith('…')).toBe(true);
});

test('источник из другого диалога проекта — с его названием и автором-агентом', () => {
  const store = fixture();
  const k = store.knowledge;
  const p = k.createProject('one', 'App');
  k.assignProject('one', 'conv-aaaaaaaaaaaaaaaa', p.id);
  k.assignProject('one', 'conv-bbbbbbbbbbbbbbbb', p.id);
  k.updateChat('one', 'conv-bbbbbbbbbbbbbbbb', 0, [{ id: 'rel', kind: 'fact', text: 'Релиз в пятницу', sourceMessageIds: ['mb'] }]);
  expect(k.promote('one', 'conv-bbbbbbbbbbbbbbbb', 'rel')).toBe(true);
  const v = k.view('one', 'conv-aaaaaaaaaaaaaaaa');
  expect(v.projectEntries[0]?.sourceConversationId).toBe('conv-bbbbbbbbbbbbbbbb');
  expect(v.sources.mb).toMatchObject({ conversationId: 'conv-bbbbbbbbbbbbbbbb', conversationTitle: 'Релиз', role: 'assistant', agentKey: 'devops', excerpt: 'Релиз в пятницу' });
});

test('удалённое сообщение и чужой диалог в карту не попадают', () => {
  const store = fixture();
  const k = store.knowledge;
  k.updateChat('one', 'conv-aaaaaaaaaaaaaaaa', 0, [{ id: 'color', kind: 'decision', text: 'Синяя тема', sourceMessageIds: ['ma'] }]);
  store.db.query('DELETE FROM conversation_messages WHERE id=?').run('ma');
  expect(k.view('one', 'conv-aaaaaaaaaaaaaaaa').sources).toEqual({});
  // Даже если id чужого сообщения окажется в записи — владельцу оно не отдаётся.
  expect(k.sources('one', { entries: [{ id: 'x', kind: 'fact', text: 't', sourceMessageIds: ['mc'] }], projectEntries: [], proposals: [] })).toEqual({});
});

test('промпт агента источников не получает', () => {
  const store = fixture();
  expect('sources' in store.knowledge.snapshot('one', 'conv-aaaaaaaaaaaaaaaa')).toBe(false);
});
