import {test,expect} from 'bun:test';
import {HiggsfieldMCP,boundedVendorJson,generateHiggsfieldImage} from '../lib/higgsfield-mcp.ts';
import {NativeAccess} from '../lib/native-access.ts';
import {nativeTurnContext} from '../lib/native-context.ts';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
const job='9a21e3a9-1d33-4d81-a239-111111111111';
async function owner(work:()=>Promise<void>){const old=process.env.HIGGSFIELD_OWNER_USER_ID;process.env.HIGGSFIELD_OWNER_USER_ID='123';try{await work();}finally{if(old===undefined)delete process.env.HIGGSFIELD_OWNER_USER_ID;else process.env.HIGGSFIELD_OWNER_USER_ID=old;}}
test('MCP uses fixed endpoint, session, SSE structured results; paid call never retries',async()=>{
 const seen:any[]=[];
 const client=new HiggsfieldMCP(async()=> 'test-token', (async(url:any,init:any)=>{
  const request=JSON.parse(init.body);seen.push({url,init,request});
  if(request.method==='notifications/initialized')return new Response(null,{status:202});
  const result=request.method==='initialize'?{protocolVersion:'2025-03-26'}:{structuredContent:{credits:7}};
  return new Response('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n\n',{headers:{'content-type':'text/event-stream','mcp-session-id':'test-session'}});
 }) as typeof fetch);
 await client.initialize();expect(await client.call('balance',{})).toEqual({credits:7});expect(seen).toHaveLength(3);
 expect(seen.every(x=>x.url==='https://mcp.higgsfield.ai/mcp'&&x.init.redirect==='error')).toBe(true);expect(seen[2].init.headers['Mcp-Session-Id']).toBe('test-session');
 let calls=0;const failing=new HiggsfieldMCP(async()=> 'test-token',(async()=>{calls++;throw Error('timeout');}) as unknown as typeof fetch);
 await expect(failing.call('generate_image',{params:{}})).rejects.toThrow();expect(calls).toBe(1);
});
test('bounded MCP response refuses oversized body',async()=>{
 await expect(boundedVendorJson(new Response('x'.repeat(2*1024*1024+1)))).rejects.toThrow('большой');
});
test('Higgsfield preflights, polls original job and downloads only completed real image',async()=>owner(async()=>{
 const calls:any[]=[];let downloads=0;
 const client={initialize:async()=>{},call:async(name:string,args:any)=>{calls.push({name,args});if(args.params?.get_cost)return {cost:{credits_exact:1}};if(name==='generate_image')return {results:[{id:job,status:'queued'}]};return {jobs:[{job_id:job,status:'completed',result_url:'https://cdn.example.test/image.png'}]};}};
 const value=await generateHiggsfieldImage('draw',{higgsfieldBilling:'credits'},123,{client,download:async()=>{downloads++;return png;}});
 expect(value).toEqual(png);expect(downloads).toBe(1);expect(calls).toHaveLength(3);expect(calls[1].args.params.use_unlim).toBe(false);expect(calls[2].args.jobs[0].job_id).toBe(job);
}));
test('price rejection and unknown submission do not create or repeat a job',async()=>owner(async()=>{
 let submits=0;
 const expensive={initialize:async()=>{},call:async()=>({cost:{credits_exact:100000}})};
 await expect(generateHiggsfieldImage('draw',{},123,{client:expensive})).rejects.toThrow('лимита');
 const timeout={initialize:async()=>{},call:async(_:string,args:any)=>{if(args.params.get_cost)return {cost:{credits_exact:1}};submits++;throw Error('timeout');}};
 await expect(generateHiggsfieldImage('draw',{},123,{client:timeout})).rejects.toThrow('неизвестен');expect(submits).toBe(1);
 await expect(generateHiggsfieldImage('draw',{},999,{client:timeout})).rejects.toThrow('владельцу');expect(submits).toBe(1);
}));
test('revoked native session after preflight cannot initiate a paid job',async()=>owner(async()=>{
 const s=new NativeAccess(':memory:');const token=s.redeem(s.pair('123'))!.token;const device=s.authenticate(token)!.device;s.start('higgsfield-turn',device,'123','draw');const conversationId=s.turnConversation('higgsfield-turn')!;
 let submits=0;const client={initialize:async()=>{},call:async(_:string,args:any)=>{if(args.params?.get_cost){s.revoke('123');return {cost:{credits_exact:1}};}submits++;return {};}};
 try{await nativeTurnContext.run({userId:'123',turnId:'higgsfield-turn',conversationId,linkApproval:()=>{},mediaSink:s.artifactSink('higgsfield-turn','123',device,conversationId)},async()=>{await expect(generateHiggsfieldImage('draw',{},123,{client})).rejects.toThrow('inactive');});expect(submits).toBe(0);}finally{s.db.close();}
}));

test('token refresh persists rotated credentials atomically before returning',async()=>{
 const {higgsfieldToken}=await import('../lib/higgsfield-mcp.ts');
 const {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'higgsfield-token-'));const path=join(dir,'credentials.json');
 const previous=process.env.HIGGSFIELD_CREDENTIALS_FILE;const oldFetch=globalThis.fetch;let calls=0;
 writeFileSync(path,JSON.stringify({access_token:'expired-test',refresh_token:'old-test',expires_at:1}),{mode:0o600});process.env.HIGGSFIELD_CREDENTIALS_FILE=path;
 try{
  globalThis.fetch=(async(url:any,init:any)=>{calls++;expect(url).toBe('https://clerk.higgsfield.ai/oauth/token');expect(init.redirect).toBe('error');expect(init.headers['user-agent']).toBe('higgsfield-cli/1.1.23');return Response.json({access_token:'new-test',refresh_token:'rotated-test',expires_in:3600});}) as typeof fetch;
  expect(await Promise.all([higgsfieldToken(),higgsfieldToken()])).toEqual(['new-test','new-test']);expect(calls).toBe(1);
  const saved=JSON.parse(readFileSync(path,'utf8'));expect(saved.refresh_token).toBe('rotated-test');expect(saved.access_token).toBe('new-test');expect(statSync(path).mode&0o077).toBe(0);
 }finally{globalThis.fetch=oldFetch;if(previous===undefined)delete process.env.HIGGSFIELD_CREDENTIALS_FILE;else process.env.HIGGSFIELD_CREDENTIALS_FILE=previous;rmSync(dir,{recursive:true,force:true});}
});
test('paid MCP send checks live session after awaiting token',async()=>{
 let active=true;let sends=0;
 const client=new HiggsfieldMCP(async()=>{await Promise.resolve();active=false;return 'test-token';},(async()=>{sends++;return Response.json({});}) as unknown as typeof fetch);
 await expect(client.call('generate_image',{params:{}},()=>{if(!active)throw Error('inactive');})).rejects.toThrow('inactive');expect(sends).toBe(0);
});
