import { test, expect, afterEach } from 'bun:test';
import { registerMessageHandler } from '../orchestrator/message-handler.ts';
import { CHARACTERS } from '../characters/index.ts';
import { cleanupChat } from './_helpers.ts';
import { db } from '../lib/db.ts';
const id = 999323901;
afterEach(() => { cleanupChat(id); db.query('DELETE FROM messages WHERE chat_id=?').run(String(id)); });
test('native lead waits for legacy delegate and forwards its answer through the native sink', async () => {
  const def = CHARACTERS.find(c => c.key === 'orchestrator')!;
  const specialist = CHARACTERS.find(c => c.key === 'design')!;
  const bot: any = { on() {}, telegram: { sendChatAction: async () => {} } };
  const running: any = { def, bot, id: 444, username: 'lead_native_bot' };
  const target: any = { def: specialist, bot, id: 445, username: 'design_native_bot' };
  const anthropic: any = { messages: { create: async () => ({ id:'m', type:'message', role:'assistant', model:'test', stop_reason:'end_turn', stop_sequence:null, usage:{input_tokens:0,output_tokens:0}, content:[{ type:'text', text:'@design_native_bot подготовь результат' }] }) } };
  const replies: string[] = [];
  let finished = false;
  const processor = registerMessageHandler(bot, def, running, {
    bots:[running,target], allowed:[String(id)], historyLimit:10, anthropic, model:'test',
    handoffDeps:{ bots:[running,target], anthropic, model:'test', historyLimit:10 },
    respondAsImpl: (async (opts: any, deps: any) => {
      expect(opts.triggerMessageId).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 5));
      await deps.nativeReply('design', 'Готовый результат'); finished = true;
      return { status:'answered', reply:'Готовый результат' };
    }) as any,
  });
  await processor({ chat:{id,type:'private'}, from:{id,is_bot:false}, message:{message_id:-100,text:'Сделай дизайн'}, sendChatAction:async()=>{},
    reply:async(text:string)=>{ replies.push(text); return {message_id:-200,date:1}; } } as any, { text:'Сделай дизайн',native:true });
  expect(finished).toBe(true); expect(replies.some(r=>r.includes('Готовый результат'))).toBe(true);
});
