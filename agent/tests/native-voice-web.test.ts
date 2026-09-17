import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {nativeApi,webApi} from '../lib/native-api.ts';
import {promptEcho,transcribeModels} from '../lib/native-voice.ts';
test('voice uses owner bearer, bounds input, transcribes, rechecks revocation; web isolates origin',async()=>{
 const names=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS','OPENAI_API_KEY','WEB_APP_ORIGIN'];const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));const realFetch=globalThis.fetch;
 Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'999323908',TELEGRAM_ALLOWED_GROUP_IDS:'999323908',WEB_APP_ORIGIN:'https://agent.test',OPENAI_API_KEY:'test-key'});
 const store=new NativeAccess(':memory:'),pair=store.redeem(store.pair('999323908'))!;
 const req=(path:string,body?:unknown,extra={})=>new Request(`https://agent.test/api/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${pair.token}`,...(body?{'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
 try{
 expect((await nativeApi(req('native/voice/status',undefined,{origin:'https://agent.test'}),store)).status).toBe(403);
 expect((await webApi(req('web/voice/status'),store)).status).toBe(403);
 const webHeaders={'sec-fetch-site':'same-origin',origin:'https://agent.test'};
 expect((await webApi(req('web/voice/status',undefined,webHeaders),store)).status).toBe(200);
 expect((await webApi(req('web/voice/status',undefined,{...webHeaders,cookie:'session=x'}),store)).status).toBe(403);
 expect((await webApi(req('web/voice/speech',{text:'Привет'},{...webHeaders,origin:'https://evil.test'}),store)).status).toBe(403);
 let forwarded='';const decision=await webApi(req('web/approvals/abc123/decide',{decision:'rejected'},webHeaders),store,async trusted=>{forwarded=new URL(trusted.url).pathname;expect(trusted.headers.has('origin')).toBe(false);expect(trusted.headers.has('cookie')).toBe(false);return Response.json({ok:true});});expect(decision.status).toBe(200);expect(forwarded).toBe('/api/approvals/abc123/decide');
 let calls=0;
 globalThis.fetch=(async(url:any,options:any)=>{calls++;expect(String(url)).toBe('https://api.openai.com/v1/audio/speech');const b=JSON.parse(options.body);expect(b.model).toBe('gpt-4o-mini-tts');expect(b.voice).toBe('marin');return new Response(new Uint8Array([73,68,51,1]),{headers:{'content-type':'audio/mpeg'}});}) as unknown as typeof fetch;
 expect((await nativeApi(req('native/voice/speech',{text:'x'.repeat(4001)}),store)).status).toBe(400);expect(calls).toBe(0);
 const speech=await webApi(req('web/voice/speech',{text:'Привет'},webHeaders),store);expect(speech.status).toBe(200);expect(speech.headers.get('content-type')).toBe('audio/mpeg');expect((await speech.arrayBuffer()).byteLength).toBe(4);
 expect((await nativeApi(req('native/voice/transcribe',{base64audio:'???=',mime:'audio/webm'}),store)).status).toBe(400);
 globalThis.fetch=(async(_url:any,options:any)=>{expect(options.body.get('model')).toBe('gpt-4o-transcribe');expect(options.body.get('prompt')).toContain('Claude');expect(options.body.get('language')).toBe('ru');return Response.json({text:'Здравствуйте, мир.'});}) as unknown as typeof fetch;
 expect(await (await nativeApi(req('native/voice/transcribe',{base64audio:'AQID',mime:'audio/webm;codecs=opus'}),store)).json()).toEqual({text:'Здравствуйте, мир.'});
 globalThis.fetch=(async()=>new Response('bad',{headers:{'content-type':'audio/mpeg','content-length':String(9*1024*1024)}})) as unknown as typeof fetch;
 expect((await nativeApi(req('native/voice/speech',{text:'Привет'}),store)).status).toBe(502);
 let unblock!:()=>void;const waiting=new Promise<void>(r=>unblock=r);
 globalThis.fetch=(async()=>{await waiting;return new Response('audio',{headers:{'content-type':'audio/mpeg'}});}) as unknown as typeof fetch;
 const pending=nativeApi(req('native/voice/speech',{text:'Привет'}),store);await new Promise(r=>setTimeout(r,5));expect((await nativeApi(req('native/voice/speech',{text:'Привет'}),store)).status).toBe(429);unblock();expect((await pending).status).toBe(200);
 globalThis.fetch=(async()=>{process.env.MAC_USER_IDS='';return new Response('audio',{headers:{'content-type':'audio/mpeg'}});}) as unknown as typeof fetch;
 expect((await nativeApi(req('native/voice/speech',{text:'Привет'}),store)).status).toBe(401);
 }finally{globalThis.fetch=realFetch;for(const key of names){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});
test('transcription falls back to the second model on provider or network failure',async()=>{
 const names=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS','OPENAI_API_KEY'];const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));const realFetch=globalThis.fetch;
 Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:'999323908',TELEGRAM_ALLOWED_GROUP_IDS:'999323908',OPENAI_API_KEY:'test-key'});
 const store=new NativeAccess(':memory:'),pair=store.redeem(store.pair('999323908'))!;
 const transcribe=()=>nativeApi(new Request('https://agent.test/api/native/voice/transcribe',{method:'POST',headers:{authorization:`Bearer ${pair.token}`,'content-type':'application/json'},body:JSON.stringify({base64audio:'AQID',mime:'audio/mp4'})}),store);
 try{
 expect(transcribeModels({})).toEqual(['gpt-4o-transcribe','gpt-4o-mini-transcribe']);
 expect(transcribeModels({VOICE_TRANSCRIBE_MODEL:'whisper-1',VOICE_TRANSCRIBE_FALLBACK_MODEL:' '})).toEqual(['whisper-1','gpt-4o-mini-transcribe']);
 expect(transcribeModels({VOICE_TRANSCRIBE_FALLBACK_MODEL:'gpt-4o-transcribe'})).toEqual(['gpt-4o-transcribe']);
 let seen:string[]=[];
 globalThis.fetch=(async(_url:any,options:any)=>{const model=options.body.get('model');seen.push(model);return model==='gpt-4o-transcribe'?new Response('overloaded',{status:503}):Response.json({text:'Запасная модель.'});}) as unknown as typeof fetch;
 expect(await (await transcribe()).json()).toEqual({text:'Запасная модель.'});expect(seen).toEqual(['gpt-4o-transcribe','gpt-4o-mini-transcribe']);
 seen=[];
 globalThis.fetch=(async(_url:any,options:any)=>{const model=options.body.get('model');seen.push(model);if(model==='gpt-4o-transcribe')throw new TypeError('network down');return Response.json({text:'После сбоя сети.'});}) as unknown as typeof fetch;
 expect(await (await transcribe()).json()).toEqual({text:'После сбоя сети.'});expect(seen.length).toBe(2);
 seen=[];
 globalThis.fetch=(async(_url:any,options:any)=>{seen.push(options.body.get('model'));return new Response('down',{status:500});}) as unknown as typeof fetch;
 const failed=await transcribe();expect(failed.status).toBe(502);expect(await failed.json()).toEqual({error:'voice_provider_unavailable'});expect(seen.length).toBe(2);
 expect(promptEcho('Термины пиши так: Claude, Codex.')).toBe(true);expect(promptEcho('Поставь задачу Claude')).toBe(false);
 globalThis.fetch=(async()=>Response.json({text:'Русская речь. Расставляй знаки препинания, сохраняй смысл сказанного.'})) as unknown as typeof fetch;
 expect(await (await transcribe()).json()).toEqual({text:''});
 seen=[];
 globalThis.fetch=(async(_url:any,options:any)=>{seen.push(options.body.get('model'));return Response.json({text:'С первой попытки.'});}) as unknown as typeof fetch;
 expect(await (await transcribe()).json()).toEqual({text:'С первой попытки.'});expect(seen).toEqual(['gpt-4o-transcribe']);
 }finally{globalThis.fetch=realFetch;for(const key of names){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});
