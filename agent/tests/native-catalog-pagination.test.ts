import { test, expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { nativeApi } from '../lib/native-api.ts';

test('native catalog pages tied timestamps without gaps and scopes every page to its owner', async () => {
  const uid = '999323908';
  const saved = { NATIVE_APP_ENABLED:process.env.NATIVE_APP_ENABLED, MAC_USER_IDS:process.env.MAC_USER_IDS, TELEGRAM_ALLOWED_GROUP_IDS:process.env.TELEGRAM_ALLOWED_GROUP_IDS };
  Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:uid,TELEGRAM_ALLOWED_GROUP_IDS:uid});
  const store = new NativeAccess(':memory:');
  try {
    for (let i=0;i<405;i++) store.createConversation(`dialog-${String(i).padStart(12,'0')}`,uid,'History');
    store.createConversation('other-owner-dialog','other','Private');
    store.db.run('UPDATE conversations SET updated=1000');
    const {token} = store.redeem(store.pair(uid))!;
    const get = (cursor?:string) => nativeApi(new Request('https://agent.test/api/native/conversations'+(cursor === undefined ? '' : '?cursor='+encodeURIComponent(cursor)),{headers:{authorization:`Bearer ${token}`}}),store);
    const ids:string[] = [];
    let cursor:string|undefined;
    for (const count of [200,200,5]) {
      const response = await get(cursor);
      expect(response.status).toBe(200);
      const page = await response.json() as {conversations:{id:string}[];more:boolean;nextCursor:string|null};
      expect(page.conversations).toHaveLength(count);
      expect(page.more).toBe(count === 200);
      expect(page.nextCursor !== null).toBe(page.more);
      ids.push(...page.conversations.map(c=>c.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(new Set(ids).size).toBe(405);
    expect(ids).not.toContain('other-owner-dialog');
    expect(ids.at(-1)).toBe('dialog-000000000000');
    for (const invalid of ['', 'oops', '-1:dialog-000000000000', '9999999999999999:dialog-000000000000']) expect((await get(invalid)).status).toBe(400);
  } finally {
    store.db.close();
    for (const [key,value] of Object.entries(saved)) { if(value === undefined) delete process.env[key]; else process.env[key]=value; }
  }
});
