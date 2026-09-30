import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {webApi,nativeApi} from '../lib/native-api.ts';
test('persistent office cookie, reload, CSRF isolation, logout and revocation',async()=>{
 const names=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS','WEB_APP_ORIGIN'];
 const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'999323908',TELEGRAM_ALLOWED_GROUP_IDS:'999323908',WEB_APP_ORIGIN:'https://agent.test'});
 const store=new NativeAccess(':memory:');
 const request=(path:string,body?:unknown,cookie='',extra:Record<string,string>={})=>new Request('https://agent.test/api/web/'+path,{method:body===undefined?'GET':'POST',headers:{'sec-fetch-site':'same-origin',origin:'https://agent.test',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 try {
  expect((await webApi(request('session'),store)).status).toBe(401);
  const pair=await webApi(request('session/pair',{code:store.pair('999323908')}),store);
  expect(pair.status).toBe(200);expect(await pair.json()).toEqual({authenticated:true});
  const header=pair.headers.get('set-cookie')!;
  for(const flag of ['HttpOnly','Secure','SameSite=Strict','Max-Age=2592000','Path=/'])expect(header).toContain(flag);
  const cookie=header.split(';')[0];
  expect((await webApi(request('session',undefined,cookie),store)).status).toBe(200);
  expect((await webApi(request('session/logout',{},cookie,{origin:'https://evil.test'}),store)).status).toBe(403);
  expect((await webApi(request('session',undefined,cookie,{'sec-fetch-site':'cross-site'}),store)).status).toBe(403);
  expect((await webApi(request('session',undefined,cookie+'; '+cookie),store)).status).toBe(403);
  expect((await nativeApi(new Request('https://agent.test/api/native/conversations',{headers:{cookie}}),store)).status).toBe(401);
  let forwarded='';
  await webApi(request('approvals/test/decide',{decision:'rejected'},cookie),store,async r=>{expect(r.headers.has('cookie')).toBe(false);expect(r.headers.has('origin')).toBe(false);forwarded=r.headers.get('authorization')??'';return Response.json({ok:true});});
  expect(forwarded).toMatch(/^Bearer [a-f0-9]{64}$/);
  const other=store.redeem(store.pair('999323908'))!;
  const logout=await webApi(request('session/logout',{},cookie),store);expect(logout.status).toBe(200);expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await webApi(request('session',undefined,cookie),store)).status).toBe(401);
  expect(store.authenticate(other.token)).not.toBeNull();
  const again=await webApi(request('session/pair',{code:store.pair('999323908')}),store);
  const nextCookie=again.headers.get('set-cookie')!.split(';')[0];store.revoke('999323908');
  expect((await webApi(request('session',undefined,nextCookie),store)).status).toBe(401);
 } finally { for(const n of names){if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];} }
});
