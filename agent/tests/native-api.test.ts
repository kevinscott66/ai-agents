import { test, expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { nativeApi, configureNativeLead } from '../lib/native-api.ts';
const uid = '999323908';
test('native API binds device to owner; rejects browser, revoked ACL and repeat execution', async () => {
  const saved = { NATIVE_APP_ENABLED: process.env.NATIVE_APP_ENABLED, MAC_USER_IDS: process.env.MAC_USER_IDS, TELEGRAM_ALLOWED_GROUP_IDS: process.env.TELEGRAM_ALLOWED_GROUP_IDS };
  Object.assign(process.env, { NATIVE_APP_ENABLED: 'true', MAC_USER_IDS: uid, TELEGRAM_ALLOWED_GROUP_IDS: uid });
  const store = new NativeAccess(':memory:');
  let runs = 0;
  const restore = configureNativeLead(async (user, text, reply) => { expect(user).toBe(uid); runs++; reply(`Ответ: ${text}`); });
  const req = (path: string, token?: string, body?: unknown, extra = {}) => new Request(`https://agent.test/api/native/${path}`, {
    method: body ? 'POST' : 'GET', headers: { ...(body ? {'content-type':'application/json'} : {}), ...(token ? {authorization:`Bearer ${token}`} : {}), ...extra }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const code = store.pair(uid);
    const pair = await nativeApi(req('pair', undefined, {code}), store);
    expect(pair.status).toBe(200);
    const { token } = await pair.json() as {token:string};
    expect((await nativeApi(req('pair', undefined, {code}), store)).status).toBe(401);
    expect((await nativeApi(req('status', token, undefined, {origin:'https://evil.test'}), store)).status).toBe(403);
    const id = 'native-turn-00000001';
    expect((await nativeApi(req('turns', token, {id,text:'hello'}), store)).status).toBe(202);
    await Promise.resolve(); await Promise.resolve();
    expect((await nativeApi(req('turns', token, {id,text:'hello'}), store)).status).toBe(202);
    expect(runs).toBe(1);
    const result = await (await nativeApi(req(`turns/${id}`, token), store)).json() as any;
    expect(result.replies).toEqual(['Ответ: hello']);
    const second = store.redeem(store.pair(uid))!;
    expect((await nativeApi(req(`turns/${id}`, second.token), store)).status).toBe(404);
    process.env.MAC_USER_IDS = '';
    expect((await nativeApi(req('status', token), store)).status).toBe(401);
    process.env.MAC_USER_IDS = uid;
    store.revoke(uid);
    expect((await nativeApi(req('status', token), store)).status).toBe(401);
  } finally {
    restore(); store.db.close();
    for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('unauthenticated requests do not read body; synchronous lead failure does not strand a running turn', async () => {
  const saved = { NATIVE_APP_ENABLED: process.env.NATIVE_APP_ENABLED, MAC_USER_IDS: process.env.MAC_USER_IDS, TELEGRAM_ALLOWED_GROUP_IDS: process.env.TELEGRAM_ALLOWED_GROUP_IDS };
  Object.assign(process.env, { NATIVE_APP_ENABLED:'true', MAC_USER_IDS:uid, TELEGRAM_ALLOWED_GROUP_IDS:uid });
  const store = new NativeAccess(':memory:');
  const restore = configureNativeLead(() => { throw new Error('synchronous failure'); });
  try {
    const blocked = await nativeApi(new Request('https://agent.test/api/native/turns', {method:'POST', headers:{'content-type':'application/json'}, body:new ReadableStream()}), store);
    expect(blocked.status).toBe(401);
    const {token} = store.redeem(store.pair(uid))!;
    const req = new Request('https://agent.test/api/native/turns', {method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${token}`}, body:JSON.stringify({id:'sync-throw-native-id',text:'hello'})});
    expect((await nativeApi(req, store)).status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 0));
    const device = store.authenticate(token)!.device;
    expect(store.get('sync-throw-native-id',device)?.status).toBe('error');
    expect(store.start('next-turn',device,uid,'next')).toBe('created');
  } finally {
    restore(); store.db.close();
    for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
