import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';

test('approval links enforce turn ownership and results persist exactly once after turn pruning', () => {
  const store = new NativeAccess(':memory:');
  try {
    const first='native-dialog-00001', second='native-dialog-00002';
    store.createConversation(first,'1','One'); store.createConversation(second,'2','Two');
    store.start('native-turn-00001','d1','1','run',first);
    store.start('native-turn-00002','d2','2','run',second);
    store.linkApproval('denied','native-turn-00001','2');
    expect(store.conversationApprovals(first,'1')).toEqual([]);
    expect(store.conversationApprovals(first,'2')).toBeNull();
    store.linkApproval('approval-1','native-turn-00001','1');
    store.linkApproval('approval-1','native-turn-00002','2');
    expect(store.conversationApprovals(second,'2')).toEqual([]);
    store.completeApproval('approval-1','2',true,'wrong owner');
    expect(store.conversationApprovals(first,'1')![0].execution).toBeNull();
    store.finish('native-turn-00001','done');
    store.prune(Date.now()+8*86400000);
    store.completeApproval('approval-1','1',true,'completed result');
    store.completeApproval('approval-1','1',false,'duplicate completion');
    expect(store.conversationApprovals(first,'1')![0].execution).toBe('completed');
    expect(store.history(first,'1')!.messages.map(m=>m.text)).toEqual(['run','completed result']);
  } finally {store.db.close();}
});
