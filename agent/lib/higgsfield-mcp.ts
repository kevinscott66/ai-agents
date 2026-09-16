/** Fixed official MCP endpoint. No vendor credentials or URLs are model-controlled. */
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MINUTE_MS, SECOND_MS } from './time-constants.ts';
import { redactPromptForVendor } from './openai-image.ts';
import { nativeMediaSink } from './native-context.ts';
import { downloadNativeImage, nativeImageType } from './native-output.ts';
const MCP_URL = 'https://mcp.higgsfield.ai/mcp';
const TOKEN_URL = 'https://clerk.higgsfield.ai/oauth/token';
// Public installed Higgsfield CLI OAuth client; private credentials are provisioned separately.
const CLI_CLIENT_ID = 'sRGCQJvvJkPrrtRj';
const MAX_RESPONSE = 2 * 1024 * 1024;

type Json = Record<string, any>;
export async function boundedVendorJson(response: Response): Promise<any> {
  if (!response.body) throw new Error('Higgsfield: пустой ответ.');
  const reader = response.body.getReader(); const chunks:Uint8Array[]=[]; let length=0;
  try { while(true) { const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>MAX_RESPONSE)throw new Error('Higgsfield: ответ слишком большой.');chunks.push(value); } }
  catch(e) { await reader.cancel().catch(()=>{});throw e; }
  finally { reader.releaseLock(); }
  const body=Buffer.concat(chunks,length).toString('utf8');
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages=body.replace(/\r\n/g,'\n').split('\n\n').flatMap(event=> {
      const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)return [];try{return [JSON.parse(data)];}catch{return [];}
    });
    const reply=messages.findLast(message=>message.id !== undefined);
    if(!reply)throw new Error('Higgsfield: некорректный MCP-ответ.');return reply;
  }
  try{return JSON.parse(body);}catch{throw new Error('Higgsfield: некорректный JSON.');}
}
let refreshing:Promise<string>|undefined;
async function readToken():Promise<string> {
  const path=process.env.HIGGSFIELD_CREDENTIALS_FILE;
  if(!path)throw new Error('Higgsfield не подключён: требуется вход владельца.');
  let c:Json;
  try {
    const info=await stat(path);if(!info.isFile() || info.size>65536 || (info.mode & 0o077))throw new Error();
    c=JSON.parse(await readFile(path,'utf8'));
  } catch {throw new Error('Higgsfield: недоступен защищённый файл авторизации.');}
  const expiry=typeof c.expires_at==='number' ? c.expires_at*SECOND_MS : Date.parse(c.expires_at);
  if(typeof c.access_token==='string' && Number.isFinite(expiry) && expiry>Date.now()+MINUTE_MS)return c.access_token;
  if(typeof c.refresh_token!=='string')throw new Error('Higgsfield: авторизация истекла, повторите вход.');
  const response=await fetch(TOKEN_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20*SECOND_MS),headers:{'content-type':'application/x-www-form-urlencoded','user-agent':'higgsfield-cli/1.1.23'},body:new URLSearchParams({grant_type:'refresh_token',client_id:typeof c.client_id==='string'?c.client_id:CLI_CLIENT_ID,refresh_token:c.refresh_token})});
  if(!response.ok){await response.body?.cancel();throw new Error('Higgsfield: не удалось обновить авторизацию, повторите вход.');}
  const value=await boundedVendorJson(response);
  if(typeof value.access_token!=='string' || !Number.isFinite(value.expires_in) || value.expires_in<=0)throw new Error('Higgsfield: некорректный ответ авторизации.');
  const next={...c,access_token:value.access_token,refresh_token:typeof value.refresh_token==='string'?value.refresh_token:c.refresh_token,expires_at:Math.floor(Date.now()/SECOND_MS)+value.expires_in};
  const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(next),{mode:0o600,flag:'wx'});await rename(tmp,path);
  return next.access_token;
}
export async function higgsfieldToken():Promise<string> {
  if(!refreshing)refreshing=readToken().finally(()=>{refreshing=undefined;});return refreshing;
}
export class HiggsfieldMCP {
  private session:string|undefined;private sequence=0;
  constructor(private token:()=>Promise<string>=higgsfieldToken,private send:typeof fetch=fetch){}
  private async rpc(method:string,params:Json,notification=false,beforeSend?:()=>void):Promise<any> {
    const id=++this.sequence;
    const token=await this.token();
    beforeSend?.();
    const response=await this.send(MCP_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60*SECOND_MS),headers:{Authorization:'Bearer '+token,'content-type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26',...(this.session?{'Mcp-Session-Id':this.session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
    // Never retry tools/call: a timed-out generation may already have been billed.
    if(!response.ok){await response.body?.cancel();throw new Error(response.status===401?'Higgsfield: требуется повторный вход.':`Higgsfield MCP: HTTP ${response.status}; запрос автоматически не повторяется.`);}
    const session=response.headers.get('mcp-session-id');if(session)this.session=session;
    if(notification){await response.body?.cancel();return;}
    const reply=await boundedVendorJson(response);
    if(reply.id!==id || reply.error || !reply.result)throw new Error('Higgsfield: ошибка протокола MCP.');
    return reply.result;
  }
  async initialize(){await this.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Agent',version:'0.1.12'}});await this.rpc('notifications/initialized',{},true);}
  async call(name:'generate_image'|'jobs_wait'|'balance',args:Json,beforeSend?:()=>void):Promise<Json> {
    const result=await this.rpc('tools/call',{name,arguments:args},false,beforeSend);
    if(result.isError)throw new Error('Higgsfield: инструмент отклонил запрос. Проверьте подключение и баланс.');
    if(result.structuredContent && typeof result.structuredContent==='object')return result.structuredContent;
    for(const block of result.content??[])if(block.type==='text'){try{const value=JSON.parse(block.text);if(value && typeof value==='object')return value;}catch{}}
    throw new Error('Higgsfield: отсутствует структурированный результат.');
  }
}
export interface HiggsfieldImageOptions {size?:string;quality?:string;background?:string;higgsfieldBilling?:'credits'|'unlimited'}
type ImageDeps={client?:Pick<HiggsfieldMCP,'initialize'|'call'>;download?:(url:string)=>Promise<Buffer>;sleep?:(ms:number)=>Promise<void>;now?:()=>number};
export async function generateHiggsfieldImage(prompt:string,opts:HiggsfieldImageOptions,chatId:number,deps:ImageDeps={}):Promise<Buffer> {
  if(String(chatId)!==process.env.HIGGSFIELD_OWNER_USER_ID)throw new Error('Higgsfield доступен только подключившему его владельцу в личном чате.');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw new Error('Higgsfield: промпт должен содержать от1 до4000 символов.');
  if(opts.background==='transparent')throw new Error('Higgsfield: прозрачный фон в этой интеграции не поддерживается; выберите OpenAI.');
  const client=deps.client??new HiggsfieldMCP();await client.initialize();
  const params:Json={model:'gpt_image_2_5',prompt:redactPromptForVendor(prompt),count:1,resolution:'1k',quality:opts.quality==='high'?'high':opts.quality==='low'?'low':'medium',aspect_ratio:opts.size==='1024x1536'?'2:3':opts.size==='1536x1024'?'3:2':'1:1',...(opts.higgsfieldBilling?{use_unlim:opts.higgsfieldBilling==='unlimited'}:{})};
  const price=await client.call('generate_image',{params:{...params,get_cost:true}});
  const credits=price.cost?.credits_exact??price.cost?.credits;
  const limit=Number(process.env.HIGGSFIELD_MAX_IMAGE_CREDITS??10);
  if(!Number.isFinite(credits)||credits<0||!Number.isFinite(limit)||limit<=0||credits>limit)throw new Error('Higgsfield: стоимость неизвестна или выше установленного лимита. Генерация не отправлена.');
  nativeMediaSink(chatId); // Revalidate after asynchronous preflight, before any paid side effect.
  let submitted:Json;
  try {submitted=await client.call('generate_image',{params},()=>{nativeMediaSink(chatId);});}
  catch {throw new Error('Higgsfield: результат отправки неизвестен. Проверьте Assets в Higgsfield перед повтором; автоматического повтора нет.');}
  if(submitted.unlim_choice)throw new Error('Higgsfield: выберите оплату кредитами или доступными unlimited-генерациями. Запрос ещё не отправлен.');
  const first=submitted.results?.[0];
  if(!first || typeof first.id!=='string' || !/^[a-f0-9-]{36}$/i.test(first.id))throw new Error('Higgsfield не вернул задание. Проверьте баланс и доступ к модели в Higgsfield.');
  const now=deps.now??Date.now;const deadline=now()+8*MINUTE_MS;
  let result=first;
  while(result.status!=='completed') {
    if(['failed','canceled','nsfw','ip_detected'].includes(result.status))throw new Error(`Higgsfield: генерация ${first.id} завершилась без изображения (${result.status}).`);
    if(now()>=deadline)throw new Error(`Higgsfield: ожидание завершено, задание ${first.id} может продолжаться. Проверьте Assets перед повтором.`);
    const poll=await client.call('jobs_wait',{jobs:[{index:0,job_id:first.id}],timeout_seconds:15});
    result=poll.jobs?.find((job:Json)=>job.job_id===first.id);
    if(!result || result.status==='lookup_failed')throw new Error(`Higgsfield: статус задания ${first.id} неизвестен; генерация не повторена.`);
    if(result.status!=='completed')await (deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(Math.max(1,Math.min(Number(poll.poll_after_seconds)||2,15))*SECOND_MS);
  }
  const url=result.result_url??result.results?.rawUrl;
  if(typeof url!=='string' || !url.startsWith('https://'))throw new Error('Higgsfield: нет безопасной ссылки на изображение.');
  const data=await (deps.download??downloadNativeImage)(url);nativeImageType(data);return data;
}
