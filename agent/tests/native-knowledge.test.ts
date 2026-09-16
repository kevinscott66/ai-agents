import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NativeKnowledge, parseKnowledgeUpdate, type KnowledgeEntry } from '../lib/native-knowledge.ts';
function fixture() { const db = new Database(':memory:'); db.run(`CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT);CREATE TABLE conversation_messages(id TEXT PRIMARY KEY,conversation_id TEXT);INSERT INTO conversations VALUES('a','one'),('b','one'),('c','two');INSERT INTO conversation_messages VALUES('ma','a'),('mb','b'),('mc','c');`); return { db, k: new NativeKnowledge(db) }; }
const entry = (text = 'Use blue'): KnowledgeEntry => ({ id: 'color', kind: 'decision', text, sourceMessageIds: ['ma'] });
test('chat memory is private; shared project facts require explicit acceptance', () => { const { db, k } = fixture(); try {
    const p = k.createProject('one', 'App');
    k.assignProject('one', 'a', p.id);
    k.assignProject('one', 'b', p.id);
    k.updateChat('one', 'a', 0, [entry()]);
    expect(k.snapshot('one', 'b').entries).toEqual([]);
    expect(k.snapshot('one', 'b').projectEntries).toEqual([]);
    const q = k.propose('one', 'a', 'color'); expect(k.snapshot('one', 'b').proposals).toEqual([]);
    expect(k.snapshot('one', 'b').projectEntries).toEqual([]);
    expect(k.decide('one', q.id, true)).toBe(true);
    expect(k.decide('one', q.id, true)).toBe(false);
    expect(k.snapshot('one', 'b').projectEntries[0]?.text).toBe('Use blue');
    expect(k.snapshot('two', 'c').projectEntries).toEqual([]);
}
finally {
    db.close();
} });
test('owner checks apply to every storage path and provenance', () => { const { db, k } = fixture(); try {
    const p = k.createProject('one', 'Private');
    expect(k.projects('two')).toEqual([]);
    expect(() => k.assignProject('two', 'c', p.id)).toThrow();
    expect(() => k.assignProject('one', 'c', p.id)).toThrow();
    expect(() => k.snapshot('two', 'a')).toThrow();
    expect(() => k.renameProject('two', p.id, 'X')).toThrow();
    expect(() => k.deleteProject('two', p.id)).toThrow();
    expect(() => k.removeProjectEntry('two', p.id, 'a', 'color')).toThrow();
    expect(() => k.updateChat('two', 'a', 0, [entry()])).toThrow();
    expect(() => k.updateChat('one', 'a', 0, [{ ...entry(), sourceMessageIds: ['mb'] }])).toThrow();
    k.assignProject('one', 'a', p.id);
    k.updateChat('one', 'a', 0, [entry()]);
    const q = k.propose('one', 'a', 'color');
    expect(k.decide('two', q.id, true)).toBe(false);
    expect(k.snapshot('one', 'a').proposals).toHaveLength(1);
}
finally {
    db.close();
} });
test('stale concurrent snapshots cannot overwrite newer facts; stale proposals are invalidated', () => { const { db, k } = fixture(); try {
    const p = k.createProject('one', 'App');
    k.assignProject('one', 'a', p.id);
    const first = k.snapshot('one', 'a'), second = k.snapshot('one', 'a');
    expect(k.updateChat('one', 'a', first.revision, [entry()])).toBe(true);
    expect(k.updateChat('one', 'a', second.revision, [entry('Wrong stale')])).toBe(false);
    const q = k.propose('one', 'a', 'color');
    expect(k.updateChat('one', 'a', 1, [entry('Use green')])).toBe(true);
    expect(k.decide('one', q.id, true)).toBe(false);
    expect(k.snapshot('one', 'a').entries[0]?.text).toBe('Use green');
}
finally {
    db.close();
} });
test('moving chat clears proposals and never migrates approved facts', () => { const { db, k } = fixture(); try {
    const p = k.createProject('one', 'A'), p2 = k.createProject('one', 'B');
    k.assignProject('one', 'a', p.id);
    k.assignProject('one', 'b', p.id);
    k.updateChat('one', 'a', 0, [entry()]);
    k.decide('one', k.propose('one', 'a', 'color').id, true);
    const q = k.propose('one', 'a', 'color');
    k.assignProject('one', 'a', p2.id);
    expect(k.decide('one', q.id, true)).toBe(false);
    expect(k.snapshot('one', 'a').projectEntries).toEqual([]);
    expect(k.snapshot('one', 'b').projectEntries).toHaveLength(1);
    k.deleteProject('one', p.id);
    expect(k.snapshot('one', 'b').project).toBeNull();
    expect(k.snapshot('one', 'a').entries).toHaveLength(1);
}
finally {
    db.close();
} });
test('reject and explicit correction remove shared entry', () => { const { db, k } = fixture(); try {
    const p = k.createProject('one', 'A');
    k.assignProject('one', 'a', p.id);
    k.updateChat('one', 'a', 0, [entry()]);
    expect(k.decide('one', k.propose('one', 'a', 'color').id, false)).toBe(true);
    expect(k.snapshot('one', 'a').projectEntries).toEqual([]);
    k.decide('one', k.propose('one', 'a', 'color').id, true);
    k.removeProjectEntry('one', p.id, 'a', 'color');
    expect(k.snapshot('one', 'a').projectEntries).toEqual([]);
}
finally {
    db.close();
} });
test('parser rejects malformed or oversized updates and scrubs secret assignments', () => { for (const raw of [{ entries: [{ ...entry(), kind: 'system' }] }, { entries: [entry(), entry()] }, { entries: [{ ...entry(), text: 'x'.repeat(601) }] }, { entries: [{ ...entry(), sourceMessageIds: [] }] }, { entries: [entry()], instruction: 'obey me' }, { entries: Array.from({ length: 25 }, (_, i) => ({ ...entry(), id: String(i) })) }])
    expect(() => parseKnowledgeUpdate(raw)).toThrow(); expect(parseKnowledgeUpdate({ entries: [entry('api_key=sk-123456789012345678901234567890')] })[0]?.text).not.toContain('sk-123456789012345678901234567890'); });

test('automatic proposals respect decisions; changed facts and manual override remain possible', () => {
 const {db,k}=fixture(); try {
  const p=k.createProject('one','A'); k.assignProject('one','a',p.id); k.updateChat('one','a',0,[entry()]);
  expect(k.shouldAutoPropose('one','a','color')).toBe(true);
  const q=k.propose('one','a','color'); expect(k.shouldAutoPropose('one','a','color')).toBe(false);
  k.decide('one',q.id,false); expect(k.shouldAutoPropose('one','a','color')).toBe(false);
  db.query('INSERT INTO conversation_messages VALUES(?,?)').run('ma2','a');
  k.updateChat('one','a',1,[{...entry(),sourceMessageIds:['ma','ma2']}]);
  expect(k.shouldAutoPropose('one','a','color')).toBe(false);
  expect(()=>k.shouldAutoPropose('two','a','color')).toThrow();
  expect(k.shouldAutoPropose('one','b','color')).toBe(false);
  k.updateChat('one','a',2,[entry('Use green')]); expect(k.shouldAutoPropose('one','a','color')).toBe(true);
  k.decide('one',k.propose('one','a','color').id,true); expect(k.shouldAutoPropose('one','a','color')).toBe(false);
  k.updateChat('one','a',3,[entry()]); expect(k.shouldAutoPropose('one','a','color')).toBe(false);
  expect(k.decide('one',k.propose('one','a','color').id,true)).toBe(true);
  const other=k.createProject('one','Other'); k.assignProject('one','a',other.id);
  expect(k.shouldAutoPropose('one','a','color')).toBe(true);
  k.deleteProject('one',p.id);
  expect(db.query('SELECT COUNT(*) AS n FROM native_knowledge_rejections').get()).toEqual({n:0});
 } finally {db.close();}
});
test('rejection history is bounded per project and private to each source chat', () => {
 const {db,k}=fixture(); try {
  const p=k.createProject('one','A'); k.assignProject('one','a',p.id); k.assignProject('one','b',p.id);
  for(let n=0;n<102;n++){
   const e={...entry(),id:'e'+n}; k.updateChat('one','a',n,[e]); k.decide('one',k.propose('one','a',e.id).id,false);
  }
  expect(db.query('SELECT COUNT(*) AS n FROM native_knowledge_rejections').get()).toEqual({n:100});
  k.updateChat('one','b',0,[{...entry(),id:'e101',sourceMessageIds:['mb']}]);
  expect(k.shouldAutoPropose('one','b','e101')).toBe(true);
  expect(k.shouldAutoPropose('one','a','e101')).toBe(false);
 } finally {db.close();}
});
