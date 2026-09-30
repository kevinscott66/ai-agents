import { test,expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { nativeApi,webApi } from '../lib/native-api.ts';
test('remote relay native authentication and web adapter isolation',async()=>{
 const keys=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS','WEB_APP_ORIGIN'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'999323908',TELEGRAM_ALLOWED_GROUP_IDS:'999323908',WEB_APP_ORIGIN:'https://agent.test'});
 const store=new NativeAccess(':memory:');
 const request=(token?:string,origin?:string)=>new Request('http://localhost/api/native/remote/hosts',{headers:{...(token?{authorization:'Bearer '+token}:{}),...(origin?{origin}:{})}});
 try {
  expect((await nativeApi(request(),store)).status).toBe(401);
  const pair=store.redeem(store.pair('999323908'))!;
  expect((await nativeApi(request(pair.token,'https://agent.test'),store)).status).toBe(403);
  expect((await nativeApi(request(pair.token),store)).status).toBe(200);
  for(const method of ['GET','POST']){
   const web=new Request('https://agent.test/api/web/remote/hosts',{method,headers:{authorization:'Bearer '+pair.token,origin:'https://agent.test','sec-fetch-site':'same-origin'}});
   expect((await webApi(web,store)).status).toBe(403);
  }
 }finally{store.db.close();for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key]}}
});
