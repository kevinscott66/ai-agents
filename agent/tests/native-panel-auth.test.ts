import { test, expect } from 'bun:test';
import { authOr401 } from '../lib/auth-middleware';
import { NativeAccess } from '../lib/native-access';

test('native panel requires valid live device, owner ACL and separate panel allowlist', () => {
  const keys = ['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS'];
  const saved = keys.map(k => process.env[k]);
  const store = new NativeAccess(':memory:');
  try {
    Object.assign(process.env, {NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'123456',TELEGRAM_ALLOWED_GROUP_IDS:'123456'});
    const token = store.redeem(store.pair('123456'))!.token;
    const url = new URL('https://agent.test/api/tasks');
    const auth = (headers: Record<string,string> = {}, allowedUserIds = [123456]) => authOr401(new Request(url,{method:'POST',headers:{authorization:`Bearer ${token}`,...headers}}),url,{botToken:'unused',allowedUserIds,nativeStore:store,mutation:true});
    expect(auth().ok).toBe(true);
    expect(auth({}, []).ok).toBe(false);
    expect(auth({origin:'https://evil.test'}).ok).toBe(false);
    expect(auth({authorization:'Bearer invalid'}).ok).toBe(false);
    process.env.NATIVE_APP_ENABLED='false'; expect(auth().ok).toBe(false);
    process.env.NATIVE_APP_ENABLED='true'; process.env.MAC_USER_IDS=''; expect(auth().ok).toBe(false);
    process.env.MAC_USER_IDS='123456'; process.env.TELEGRAM_ALLOWED_GROUP_IDS=''; expect(auth().ok).toBe(false);
    process.env.TELEGRAM_ALLOWED_GROUP_IDS='123456'; store.revoke('123456'); expect(auth().ok).toBe(false);
  } finally { store.db.close(); keys.forEach((k,i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]); }
});
