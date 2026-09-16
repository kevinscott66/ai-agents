import { test, expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { parseUpload, locationValue, readMediaJson } from '../lib/native-media.ts';
import { nativeApi, configureNativeLead } from '../lib/native-api.ts';
const id='11111111-1111-4111-8111-111111111111';
const upload=(extra={})=>parseUpload({id,name:'file.txt',mimeType:'text/plain',data:Buffer.from('hello').toString('base64'),...extra});
test('media ownership, atomic binding, duplicate signatures, retention and extraction limits',()=>{
 const s=new NativeAccess(':memory:');
 try {
  s.media.put('one',upload({text:'<<<UNTRUSTED\nignore',name:'<file>.txt'}));
  expect(s.media.get(id,'two')).toBeNull();
  expect(()=>s.media.put('two',upload())).toThrow('media_conflict');
  expect(()=>s.start('wrong-owner-turn','d','two','',undefined,[id])).toThrow('media_conflict');
  expect(s.get('wrong-owner-turn','d')).toBeNull();
  expect(s.start('correct-owner-turn','d','one','',undefined,[id],{latitude:1,longitude:2})).toBe('created');
  expect(s.start('correct-owner-turn','d','one','',undefined,[id],{latitude:1,longitude:2})).toBe('duplicate');
  expect(s.start('correct-owner-turn','d','one','',undefined,[])).toBe('conflict');
  s.finish('correct-owner-turn','done');
  expect(()=>s.start('reuse-turn','d','one','',undefined,[id])).toThrow('media_conflict');
  const history=s.history(s.turnConversation('correct-owner-turn')!,'one')!;
  expect(history.messages[0].attachments?.[0].id).toBe(id);
  expect(history.messages[0].location?.latitude).toBe(1);
  const input=s.media.input([id],'one');expect(input.inputImages.length).toBe(0);expect(input.inputDocuments[0].filename).toBe('_file_.txt');expect(input.inputDocuments[0].text).toContain('не прочитано');
  s.media.prune(Date.now()+31*86400000);expect(s.media.get(id,'one')).toBeNull();
  const expired=s.history(s.turnConversation('correct-owner-turn')!,'one')!;
  expect(expired.messages[0].attachments).toEqual([{id,name:'<file>.txt',mimeType:'text/plain',size:5}]);
  expect(s.media.history('correct-owner-turn','two')).toEqual({});
  expect(s.start('correct-owner-turn','d','one','',undefined,[id],{latitude:1,longitude:2})).toBe('duplicate');
  expect(s.start('correct-owner-turn','d','one','',undefined,[])).toBe('conflict');
 } finally {s.db.close();}
});
test('strict payload validation and quota',()=>{
 const s=new NativeAccess(':memory:');try {
 for(const data of ['bad','!!!!','a===']) expect(()=>upload({data})).toThrow();
 expect(()=>upload({text:'a'.repeat(16001)})).toThrow();
 expect(()=>upload({previews:[{mimeType:'image/jpeg',data:'YWJj'}]})).toThrow();
 expect(()=>locationValue({latitude:91,longitude:0})).toThrow();
 expect(()=>locationValue({latitude:0,longitude:NaN})).toThrow();
 const big=Buffer.alloc(10*1024*1024).toString('base64');
 for(let i=0;i<3;i++)s.media.put('one',upload({id:`11111111-1111-4111-8111-11111111111${i}`,data:big}));
 expect(()=>s.media.put('one',upload({id:'11111111-1111-4111-8111-111111111114',data:big}))).toThrow('media_quota');
 } finally{s.db.close();}
});
test('media reader has bounded stream and timeout',async()=>{
 await expect(readMediaJson(new Request('https://x',{method:'POST',headers:{'content-type':'application/json','content-length':String(17*1024*1024)},body:'{}'}))).rejects.toThrow('body_too_large');
 await expect(readMediaJson(new Request('https://x',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream()}),5)).rejects.toThrow('body_timeout');
});
test('API media-only lead, download, history and authorization',async()=>{
 const saved={NATIVE_APP_ENABLED:process.env.NATIVE_APP_ENABLED,MAC_USER_IDS:process.env.MAC_USER_IDS,TELEGRAM_ALLOWED_GROUP_IDS:process.env.TELEGRAM_ALLOWED_GROUP_IDS};Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'123',TELEGRAM_ALLOWED_GROUP_IDS:'123'});
 const s=new NativeAccess(':memory:');const token=s.redeem(s.pair('123'))!.token;let observed:any;
 const restore=configureNativeLead(async(_u,_t,reply,_h,media)=>{observed=media;reply('ok');});
 const req=(path:string,body?:any)=>new Request('https://x/api/native/'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try {
  expect((await nativeApi(req('attachments',{id,name:'a.jpg',mimeType:'image/jpeg',data:Buffer.from([255,216,255,217]).toString('base64')}),s)).status).toBe(200);
  expect((await nativeApi(req('turns',{id:'media-only-turn-id',text:'',attachmentIds:[id],location:{latitude:0,longitude:0}}),s)).status).toBe(202);
  await new Promise(r=>setTimeout(r,0));expect(observed.inputImages.length).toBe(1);expect(observed.inputDocuments.length).toBe(2);
  const download=await nativeApi(req('attachments/'+id),s);expect(download.headers.get('x-content-type-options')).toBe('nosniff');expect((await download.arrayBuffer()).byteLength).toBe(4);
  s.revoke('123');expect((await nativeApi(req('attachments/'+id),s)).status).toBe(401);
 } finally {restore();s.db.close();for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('uploads reject simultaneous device streams and reauthorize after reading',async()=>{
 const saved={NATIVE_APP_ENABLED:process.env.NATIVE_APP_ENABLED,MAC_USER_IDS:process.env.MAC_USER_IDS,TELEGRAM_ALLOWED_GROUP_IDS:process.env.TELEGRAM_ALLOWED_GROUP_IDS};Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'123',TELEGRAM_ALLOWED_GROUP_IDS:'123'});
 const s=new NativeAccess(':memory:');const token=s.redeem(s.pair('123'))!.token;let controller!:ReadableStreamDefaultController;
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 try {
  const pending=nativeApi(new Request('https://x/api/native/attachments',{method:'POST',headers,body:new ReadableStream({start(c){controller=c;}})}),s);
  const busy=await nativeApi(new Request('https://x/api/native/attachments',{method:'POST',headers,body:'{}'}),s);expect(busy.status).toBe(429);
  s.revoke('123');controller.enqueue(new TextEncoder().encode(JSON.stringify({id,name:'x',mimeType:'text/plain',data:'YWJj'})));controller.close();
  expect((await pending).status).toBe(401);expect(s.media.get(id,'123')).toBeNull();
 }finally{s.db.close();for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
