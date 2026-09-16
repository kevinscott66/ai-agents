import {test,expect} from 'bun:test';
import {buildPayload} from '../lib/dispatch/build-payload.ts';
import {handleMacRunClaude} from '../lib/dispatch/mac.ts';
import {toMacSession} from '../miniapp/src/lib/mac-session.ts';

test('new requests default to fallback, explicit lock and legacy approved payload keep executor fixed',async()=>{
 const base={project:'/x',prompt:'time',mode:'ask',provider:'claude' as const};
 expect(buildPayload('MAC_RUN_CLAUDE',base,{agentKey:'orchestrator'})).toMatchObject({ok:true,payload:{allowFallback:true}});
 expect(buildPayload('MAC_RUN_CLAUDE',{...base,allowFallback:false},{agentKey:'orchestrator'})).toMatchObject({ok:true,payload:{allowFallback:false}});
 expect(buildPayload('MAC_RUN_CLAUDE',{...base,allowFallback:'yes'},{agentKey:'orchestrator'}).ok).toBe(false);
 const requests:any[]=[];const bridge={isUserAllowed:()=>true,isMacConnected:()=>true,stopMac:async()=>({ok:true}),sendToMac:async(p:any)=>{requests.push(p);return {ok:true,stdout:'time',stderr:''};}};
 await handleMacRunClaude({...base,mode:'ask',_userId:'1'}, {agentKey:'orchestrator',chatId:1,macBridge:bridge});expect(requests[0].allowFallback).toBeUndefined();
});
test('actual fallback provider and explanation survive audit result and Mac history',async()=>{
 const requests:any[]=[];const bridge={isUserAllowed:()=>true,isMacConnected:()=>true,stopMac:async()=>({ok:true}),sendToMac:async(p:any)=>{requests.push(p);return {ok:true,code:0,stdout:'08:17',stderr:'',provider:'codex' as const,requestedProvider:'claude' as const,fallbackReason:'executable_not_found'};}};
 const r=await handleMacRunClaude({project:'/x',prompt:'time',mode:'ask',provider:'claude',allowFallback:true,_userId:'1'},{agentKey:'orchestrator',chatId:1,approvalId:'approval',macBridge:bridge});
 expect(requests).toHaveLength(1);expect(requests[0].allowFallback).toBe(true);expect(r).toMatchObject({ok:true,result:{provider:'codex',requestedProvider:'claude',approvalId:'approval'}});
 if(!r.ok)return;expect(String(r.result?.output)).toContain('Codex');expect(String(r.result?.output)).toContain('08:17');
 expect(toMacSession({id:'a',status:'ok',created_at:1,payload:{provider:'claude'},result:r.result} as any).provider).toBe('codex');
});
test('dispatcher does not retry failures, unknown outcome or permissions through a second provider',async()=>{
 for(const failure of ['mac_timeout','mac_disconnected','forbidden']){
 let calls=0;const r=await handleMacRunClaude({project:'/x',prompt:'time',mode:'ask',allowFallback:true,_userId:'1'},{agentKey:'orchestrator',chatId:1,macBridge:{isUserAllowed:()=>true,isMacConnected:()=>true,stopMac:async()=>({ok:true}),sendToMac:async()=>{calls++;throw Error(failure);}}});expect(r.ok).toBe(false);expect(calls).toBe(1);
 }
});
test('bridge carries fallback opt-in and verified provider metadata',async()=>{
 const {sendToMac,_setActiveSocketForTests,_handleClientMessageForTests}=await import('../lib/mac-bridge.ts');
 const frames:string[]=[];const socket={data:{authed:true,peerKey:'test'},send:(text:string)=>{frames.push(text);}};_setActiveSocketForTests(socket);
 try{
  const result=sendToMac({provider:'claude',allowFallback:true,project:'/x',prompt:'test',mode:'ask'});
  const frame=JSON.parse(frames[0]);expect(frame.allowFallback).toBe(true);
  _handleClientMessageForTests(socket,JSON.stringify({type:'result',id:frame.id,ok:true,code:0,provider:'codex',requestedProvider:'claude',fallbackReason:'executable_not_found'}));
  expect(await result).toMatchObject({provider:'codex',requestedProvider:'claude',fallbackReason:'executable_not_found'});
 }finally{_setActiveSocketForTests(null);}
});
test('failed alternate execution preserves actual provider and bypass explains its own restriction',async()=>{
 for(const blocked of [undefined,'bypass_mode'] as const){
 const r=await handleMacRunClaude({project:'/x',prompt:'time',mode:'ask',provider:'claude',allowFallback:true,_userId:'1'},{agentKey:'orchestrator',chatId:1,macBridge:{isUserAllowed:()=>true,isMacConnected:()=>true,stopMac:async()=>({ok:true}),sendToMac:async()=>({ok:false,provider:'codex',requestedProvider:'claude',fallbackReason:'quota_exhausted',fallbackBlocked:blocked,stdout:'',stderr:'',error:'failed'})}});
 expect(r.ok).toBe(false);if(r.ok)return;
 expect(r.result).toMatchObject({provider:'codex',requestedProvider:'claude'});
 expect(toMacSession({id:'failed',status:'error',created_at:1,payload:{provider:'claude'},result:r.result} as any).provider).toBe('codex');
 if(blocked)expect(r.error).toContain('обхода разрешений');
 }
});
