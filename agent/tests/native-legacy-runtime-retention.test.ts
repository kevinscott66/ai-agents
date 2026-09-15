import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';

test('legacy clients archive each new turn without requiring a restart before pruning', () => {
  const store = new NativeAccess(':memory:');
  try {
    store.start('legacy-runtime-turn','d','owner','keep this message');
    store.append('legacy-runtime-turn','answer');
    store.finish('legacy-runtime-turn','done');
    store.prune(Date.now()+8*86400000);
    expect(store.get('legacy-runtime-turn','d')).toBeNull();
    const dialog=store.conversations('owner')[0];
    expect(dialog.id.startsWith('legacy-')).toBe(true);
    expect(store.history(dialog.id,'owner')!.messages.map(m=>m.text)).toEqual(['keep this message','answer']);
    expect(store.start('legacy-runtime-turn','d','owner','keep this message')).toBe('conflict');
    store.start('next-legacy-turn','d','owner','next');
    expect(store.conversations('owner')).toHaveLength(1);
    expect(store.history(dialog.id,'owner')!.messages.at(-1)?.text).toBe('next');
    expect(store.history(dialog.id,'another')).toBeNull();
  } finally {store.db.close();}
});
