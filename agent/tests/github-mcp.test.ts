import {test,expect} from 'bun:test';
import {readGithubMcp} from '../lib/github-mcp';
import {capabilityStatus} from '../lib/capability-status';
const owner='998760123';const ctx={agentKey:'orchestrator',chatId:Number(owner),triggerUserId:owner};
async function fixture(work:()=>Promise<void>){
 const values={GITHUB_MCP_ENABLED:'true',GITHUB_READ_TOKEN:'test-token-not-a-real-secret',GITHUB_REPO:'test-owner/test-repo',MAC_USER_IDS:owner,TELEGRAM_ALLOWED_GROUP_IDS:owner};
 const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 try{await work();}finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
function transport(calls:any[],mode='json'):typeof fetch{return (async(url:any,options:any)=>{
 const body=JSON.parse(options.body);calls.push({url,options,body});
 if(body.method==='notifications/initialized')return new Response(null,{status:202});
 const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:{content:[{type:'text',text:'fixture code'}]};
 const reply=JSON.stringify({jsonrpc:'2.0',id:body.id,result});
 return new Response(mode==='sse'?'event: message\ndata: '+reply+'\n\n':reply,{headers:{'content-type':mode==='sse'?'text/event-stream':'application/json','mcp-session-id':'test-session'}});
 }) as typeof fetch;}
test('GitHub MCP pins endpoint/repository and read operations, negotiates JSON/SSE',async()=>fixture(async()=>{
 for(const mode of ['json','sse'])for(const operation of ['file','issue','pull_request']){
  const calls:any[]=[];const result=await readGithubMcp({operation,path:'src/app.ts',number:7,owner:'attacker',repo:'elsewhere',method:'delete'},ctx,transport(calls,mode));
  expect(result.ok).toBe(true);expect(calls).toHaveLength(3);
  expect(calls.every(c=>c.url==='https://api.githubcopilot.com/mcp/readonly'&&c.options.redirect==='error'&&c.options.headers['X-MCP-Readonly']==='true')).toBe(true);
  const args=calls[2].body.params.arguments;expect(args.owner).toBe('test-owner');expect(args.repo).toBe('test-repo');
  if(operation!=='file')expect(args.method).toBe('get');
  expect(calls[2].options.headers['Mcp-Session-Id']).toBe('test-session');
 }
}));
test('rejects groups, untrusted identity, wrong roles, writes and malformed parameters before network',async()=>fixture(async()=>{
 const calls:any[]=[];const send=transport(calls);
 for(const who of [{...ctx,chatId:-100}, {...ctx,triggerUserId:undefined},{...ctx,agentKey:'backend'}])expect((await readGithubMcp({operation:'issue',number:1},who,send)).ok).toBe(false);
 for(const input of [{operation:'delete'},{operation:'file',path:'../.env'},{operation:'file',path:'src/x',ref:'\n'},{operation:'issue',number:-1}])expect((await readGithubMcp(input,ctx,send)).ok).toBe(false);
 expect(calls).toHaveLength(0);
 process.env.GITHUB_MCP_ENABLED='false';expect((await readGithubMcp({operation:'issue',number:1},ctx,send)).ok).toBe(false);
 expect(capabilityStatus().integrations.find(x=>x.id==='tbank-personal')!.configured).toBe(false);
 expect(JSON.stringify(capabilityStatus())).not.toContain(process.env.GITHUB_READ_TOKEN!);
}));
test('protocol failures, excessive bodies and revocation fail closed with sanitized errors',async()=>fixture(async()=>{
 for(const reply of [JSON.stringify({jsonrpc:'2.0',id:900,result:{}}),'x'.repeat(524289)]){
  const result=await readGithubMcp({operation:'issue',number:1},ctx,(async()=>new Response(reply)) as unknown as typeof fetch);expect(result.ok).toBe(false);
 }
 const calls:any[]=[];const base=transport(calls);
 const result=await readGithubMcp({operation:'issue',number:1},ctx,(async(...args:any[])=>{const response=await (base as any)(...args);if(calls.length===3)process.env.MAC_USER_IDS='';return response;}) as typeof fetch);
 expect(result).toEqual({ok:false,error:'mcp_access_changed'});
}));

test('SSE returns a complete matching RPC frame without waiting for stream EOF',async()=>fixture(async()=>{
 let cancelled=0;
 const send=(async(_url:any,opts:any)=>{
  const body=JSON.parse(opts.body);
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26'}:{content:[{type:'text',text:'done'}]};
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result})+'\n\n'));},cancel(){cancelled++;}});
  return new Response(stream,{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch;
 const result=await readGithubMcp({operation:'issue',number:1},ctx,send);expect(result.ok).toBe(true);expect(cancelled).toBe(2);
}));
