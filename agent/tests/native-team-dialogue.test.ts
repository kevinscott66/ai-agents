import {test,expect,afterEach} from 'bun:test';
import {registerMessageHandler} from '../orchestrator/message-handler.ts';
import {CHARACTERS} from '../characters/index.ts';
import {nativeTurnContext} from '../lib/native-context.ts';
import {respondAs,nativeReplyTransport} from '../lib/handoff.ts';
import {db} from '../lib/db.ts';
import {cleanupChat} from './_helpers.ts';
import {setAutonomy} from '../lib/permissions.ts';
const id=999323905;
afterEach(()=>{cleanupChat(id);db.query('DELETE FROM messages WHERE chat_id=?').run(String(id));});
function response(content:any[],stop_reason='end_turn'){return {id:'m',type:'message',role:'assistant',model:'test',stop_reason,stop_sequence:null,usage:{input_tokens:0,output_tokens:0},content};}
function bot(key:string,index:number){return {def:CHARACTERS.find(c=>c.key===key)!,id:440+index,username:`${key}_native_bot`,bot:{on(){},telegram:{sendChatAction:async()=>{throw new Error('Telegram forbidden');},sendMessage:async()=>{throw new Error('Telegram forbidden');}}}} as any;}
test('real native delegation executes specialists, shares authentic criticism and returns to lead for synthesis',async()=>{
 setAutonomy('chat',String(id),'auto');
 const bots=['orchestrator','backend','qa'].map(bot);const contributions:{key:string;text:string}[]=[];const requests:any[]=[];
 let call=0;
 const anthropic:any={messages:{create:async(p:any)=>{
  requests.push(p);call++;
  if(call===1)return response([{type:'tool_use',id:'d1',name:'DELEGATE_TO_ROLE',input:{role:'backend',task:'Предложи решение'}}],'tool_use');
  if(call===2){expect(p.tool_choice?.type).not.toBe('any');return response([{type:'text',text:'План backend: использовать транзакцию.'}]);}
  if(call===3){expect(JSON.stringify(p.messages)).toContain('использовать транзакцию');return response([{type:'tool_use',id:'d2',name:'DELEGATE_TO_ROLE',input:{role:'qa',task:'Проверь решение backend, найди недостатки'}}],'tool_use');}
  if(call===4){expect(JSON.stringify(p.messages)).toContain('[backend] План backend');expect(p.tool_choice?.type).not.toBe('any');return response([{type:'text',text:'Критика QA: нужен тест отката транзакции.'}]);}
  expect(JSON.stringify(p.messages)).toContain('тест отката');return response([{type:'text',text:'Итог: план принят с тестом отката.'}]);
 }}};
 const handoffDeps={bots,anthropic,model:'test',historyLimit:20};
 const process=registerMessageHandler(bots[0].bot,bots[0].def,bots[0],{...handoffDeps,allowed:[String(id)],handoffDeps});
 db.query('INSERT INTO messages(chat_id,is_bot,from_user_id,text,ts) VALUES(?,0,?,?,?)').run(String(id),String(id),'OTHER_DIALOG_SECRET',Date.now());
 await nativeTurnContext.run({userId:String(id),turnId:'test',conversationId:'test-dialog',linkApproval(){},knowledge:'SCOPED_PROJECT_FACT',reply:async(key,text)=>{contributions.push({key,text});return {message_id:-contributions.length,date:1};}},()=>process({chat:{id,type:'private'},from:{id,is_bot:false},message:{message_id:-109,text:'Обсудите решение'},sendChatAction:async()=>{},reply:async()=>{throw new Error('unattributed reply');}} as any,{text:'Обсудите решение',native:true,history:[]}));
 expect(call).toBe(5);
 expect(contributions.filter(c=>c.text.includes('План backend')||c.text.includes('Критика QA')||c.text.startsWith('Итог')).map(c=>c.key)).toEqual(['backend','qa','orchestrator']);
 expect(JSON.stringify(requests)).not.toContain('OTHER_DIALOG_SECRET');
 for(const r of requests)expect(JSON.stringify(r.system)).toContain('SCOPED_PROJECT_FACT');
 expect((db.query('SELECT count(*) n FROM messages WHERE chat_id=?').get(String(id)) as any).n).toBe(1);
});
test('native reply transport refuses a different destination',async()=>{
 let sent=false;const transport=nativeReplyTransport({sendMessage:async(..._args:any[])=>{}},String(id),'qa',async()=>{sent=true;return {message_id:1,date:1};});
 expect(()=>transport.sendMessage(id+1,'no')).toThrow('native_reply_destination_mismatch');expect(sent).toBe(false);
});
test('native specialist budget stops before model invocation',async()=>{
 let called=false;const target=bot('qa',1);
 const result=await respondAs({target,chatId:String(id),triggerText:'Review',triggerAgentKey:'orchestrator',depth:1,visited:new Set(['orchestrator']),budget:{n:2,max:2}}, {bots:[target],historyLimit:5,model:'test',anthropic:{messages:{create:async()=>{called=true;throw new Error('must not run');}}} as any,nativeHistory:[],nativeReply:async()=>({message_id:1,date:1})});
 expect(result.status).toBe('skipped');expect(called).toBe(false);
});

test('native recovery without a conversation transport fails closed',async()=>{
 const target=bot('backend',2);
 const result=await nativeTurnContext.run({userId:String(id),turnId:'recovery',conversationId:'dialog',linkApproval(){}},()=>respondAs({target,chatId:String(id),triggerText:'Execute',triggerAgentKey:'orchestrator',depth:1,visited:new Set()}, {bots:[target],historyLimit:5,model:'test',anthropic:null}));
 expect(result).toEqual({status:'failed',reason:'native_handoff_context_unavailable'});
});

test('native transport blocks unsupported Telegram mutations and raw API without exposing token',async()=>{
 let mutations=0;let reads=0;
 const methods=['sendPoll','forwardMessage','editMessageText','deleteMessage','pinChatMessage','sendPhoto','sendDocument','callApi'];
 const raw:any={token:'private-token',getChat:async()=>{reads++;return {id};}};
 for(const method of methods)raw[method]=async()=>{mutations++;};
 const transport=nativeReplyTransport(raw,String(id),'qa',async()=>({message_id:1,date:1}));
 for(const method of methods)expect(()=>transport[method](id,'payload')).toThrow('native_telegram_operation_unsupported');
 expect(transport.token).toBeUndefined();expect(mutations).toBe(0);
 expect(await transport.getChat(id)).toEqual({id});expect(reads).toBe(1);
});
