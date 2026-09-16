import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {nativeTurnContext,withNativeImageGeneration,deliverNativeMedia} from '../lib/native-context.ts';
import {tgSendPhoto,tgSendDocument} from '../lib/telegram-actions.ts';
import {downloadNativeImage} from '../lib/native-output.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
function setup(path=':memory:'){
 const s=new NativeAccess(path);const token=s.redeem(s.pair('123'))!.token;const identity=s.authenticate(token)!;
 s.start('output-turn',identity.device,'123','draw');
 const conversationId=s.turnConversation('output-turn')!;
 const context={userId:'123',turnId:'output-turn',conversationId,linkApproval:()=>{},mediaSink:s.artifactSink('output-turn','123',identity.device,conversationId)};
 return {s,identity,context};
}
test('native output has stable history attachment, only its owner can download, Telegram unchanged outside ALS',async()=>{
 const {s,identity,context}=setup();let calls=0;const tg={sendPhoto:async()=>{calls++;return {message_id:99};}} as any;
 try{
 await nativeTurnContext.run(context,async()=>{
  await withNativeImageGeneration(123,async()=>{expect(s.get('output-turn',identity.device)!.generations![0].state).toBe('running');return tgSendPhoto(tg,{chatId:123,photo:{buffer:png},caption:'art'});});
  await tgSendDocument(tg,{chatId:123,content:'hello',filename:'note.txt'});
 });
 const turn=s.get('output-turn',identity.device)!;expect(calls).toBe(0);expect(turn.replies).toEqual(['art','']);expect(turn.generations![0].state).toBe('completed');expect(turn.generations![0].ended).toBeGreaterThanOrEqual(turn.generations![0].started);
 const attachment=turn.outputMedia![0].attachments[0];expect(turn.outputMedia![0].messageId).toBe('output-turn:reply:1');expect(s.media.get(attachment.id,'other')).toBeNull();expect(s.media.get(attachment.id,'123')!.data).toEqual(png);
 expect(s.history(context.conversationId,'other')).toBeNull();expect(s.history(context.conversationId,'123')!.messages[1].attachments![0]).toEqual(attachment);
 s.media.prune(Date.now()+31*86400000);expect(s.media.get(attachment.id,'123')).toBeNull();expect(s.history(context.conversationId,'123')!.messages[1].attachments![0]).toEqual(attachment);
 await tgSendPhoto(tg,{chatId:123,photo:{buffer:png}});expect(calls).toBe(1);
 }finally{s.db.close();}
});
test('failed, stale, revoked and wrong-owner output never delivers or escapes into Telegram',async()=>{
 const {s,identity,context}=setup();let release!:()=>void;let calls=0;const tg={sendPhoto:()=>{calls++;throw Error('must not call');}} as any;
 try{
 await nativeTurnContext.run(context,async()=>{
  await expect(withNativeImageGeneration(123,async()=>{throw Error('provider');})).rejects.toThrow('provider');
  expect(s.get('output-turn',identity.device)!.generations![0].state).toBe('failed');
  await expect(tgSendPhoto(tg,{chatId:999,photo:{buffer:png}})).rejects.toThrow('owner_mismatch');
  const pending=withNativeImageGeneration(123,async()=>{await new Promise<void>(r=>release=r);return tgSendPhoto(tg,{chatId:123,photo:{buffer:png}});});
  s.finish('output-turn','done');release();await expect(pending).rejects.toThrow('inactive');
  expect(s.get('output-turn',identity.device)!.generations![1].state).toBe('interrupted');
 });
 expect(calls).toBe(0);expect(s.get('output-turn',identity.device)!.outputMedia).toBeUndefined();
 s.start('next-turn',identity.device,'123','new');const sink=s.artifactSink('next-turn','123',identity.device,s.turnConversation('next-turn')!);s.revoke('123');expect(()=>sink.deliver({data:png,name:'x.png',mimeType:'image/png'})).toThrow('inactive');
 }finally{s.db.close();}
});
test('restart interrupts in-flight generations and retains completed media',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-output-'));try{
 const path=join(dir,'native.db');const {s,identity,context}=setup(path);nativeTurnContext.run(context,()=>{deliverNativeMedia(123,{data:png,name:'x.png',mimeType:'image/png'});context.mediaSink.startGeneration();});s.db.close();
 const reopened=new NativeAccess(path);try{const t=reopened.get('output-turn',identity.device)!;expect(t.status).toBe('interrupted');expect(t.generations![0].state).toBe('interrupted');expect(t.outputMedia).toHaveLength(1);}finally{reopened.db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('native image URL rejects local/private schemes before any connection',async()=>{
 for(const url of ['file:///etc/passwd','http://127.0.0.1/a','http://169.254.169.254/x','http://[::1]/a'])await expect(downloadNativeImage(url)).rejects.toThrow('blocked');
});
test('image dispatcher reports real provider execution and failed result without Telegram fallback',async()=>{
 const {handleGenerateImage,buildGenerateImagePayload}=await import('../lib/dispatch/media.ts');
 const {s,identity,context}=setup();
 try{
 await nativeTurnContext.run(context,async()=>{
  const result=await handleGenerateImage({prompt:'draw'}, {chatId:123,agentKey:'design'}, {generate:async()=>{expect(s.get('output-turn',identity.device)!.generations![0].state).toBe('running');return png;}});
  expect(result.ok).toBe(true);expect(s.get('output-turn',identity.device)!.generations![0].state).toBe('completed');
  let fallback=0;
  const failed=await handleGenerateImage({prompt:'draw',provider:'higgsfield'}, {chatId:123,agentKey:'design'}, {generate:async()=>{throw Error('billing_hard_limit_reached');},fallbackSvg:async()=>{fallback++;return '<svg/>';}});
  expect(failed.ok).toBe(false);expect(fallback).toBe(0);expect(s.get('output-turn',identity.device)!.generations![1].state).toBe('failed');
 });
 expect(buildGenerateImagePayload({prompt:'draw',provider:'unknown'},123).ok).toBe(false);
 expect(buildGenerateImagePayload({prompt:'draw',provider:'higgsfield'},123)).toMatchObject({ok:true,payload:{provider:'higgsfield'}});
 }finally{s.db.close();}
});
