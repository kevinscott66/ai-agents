import { readNativeJson } from './native-request.ts';
const MAX=8*1024*1024, active=new Set<string>(), windows=new Map<string,{at:number;count:number}>();
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
export async function voiceApi(req:Request,owner:string,authorized:()=>boolean):Promise<Response>{
 const path=new URL(req.url).pathname, available=!!process.env.OPENAI_API_KEY?.trim();
 if(path.endsWith('/status')&&req.method==='GET')return json({available,speech:available,transcription:available,maxTextLength:4000,maxAudioBytes:MAX});
 if(req.method!=='POST'||!['/api/native/voice/speech','/api/native/voice/transcribe'].includes(path))return json({error:'not_found'},404);
 if(!available)return json({error:'voice_unavailable'},503);
 const now=Date.now();for(const [k,v]of windows)if(now-v.at>=60000)windows.delete(k);
 const w=windows.get(owner)??{at:now,count:0};if(active.has(owner)||active.size>=2||w.count>=12||windows.size>=1000)return json({error:'voice_busy'},429);
 active.add(owner);w.count++;windows.set(owner,w);
 const controller=new AbortController(),abort=()=>controller.abort();req.signal.addEventListener('abort',abort,{once:true});if(req.signal.aborted)abort();const timer=setTimeout(abort,45000);
 const deadline=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});if(controller.signal.aborted)reject(new Error('aborted'));});
 void deadline.catch(()=>{});
 try{
 const transcription=path.endsWith('/transcribe'),body=await readNativeJson(req,10000,transcription?Math.ceil(MAX/3)*4+1024:65536).catch(error=>{if(error instanceof Error&&['json_required','body_too_large','body_timeout','body_aborted'].includes(error.message))throw error;throw new Error('invalid_body');});
 if(!authorized())return json({error:'unauthorized'},401);
 let input:BodyInit;const headers:Record<string,string>={Authorization:`Bearer ${process.env.OPENAI_API_KEY}`};
 if(transcription){
 const ext:Record<string,string>={'audio/webm':'webm','audio/mp4':'mp4','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg'},mime=typeof body.mime==='string'?body.mime.split(';')[0].trim():'',data=body.base64audio;
 if(!ext[mime]||typeof data!=='string'||!data.length||data.length>Math.ceil(MAX/3)*4||data.length%4||/[^A-Za-z0-9+/=]/.test(data))return json({error:'invalid_audio'},400);
 const bytes=Buffer.from(data,'base64');if(bytes.length>MAX||bytes.toString('base64')!==data)return json({error:'invalid_audio'},400);
 const form=new FormData();form.set('file',new Blob([bytes],{type:mime}),`speech.${ext[mime]}`);form.set('model','gpt-4o-mini-transcribe');form.set('language','ru');form.set('response_format','json');form.set('prompt','Русская речь. Расставляй знаки препинания, сохраняй смысл сказанного.');input=form;
 }else{
 if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4000)return json({error:'invalid_text'},400);
 headers['Content-Type']='application/json';input=JSON.stringify({model:'gpt-4o-mini-tts',voice:'marin',input:body.text,response_format:'mp3',instructions:'Говори по-русски естественно и дружелюбно, как внимательный собеседник. Живая спокойная интонация, умеренный темп и короткие смысловые паузы.'});
 }
 if(controller.signal.aborted)throw new Error('aborted');
 const response=await Promise.race([fetch(`https://api.openai.com/v1/audio/${transcription?'transcriptions':'speech'}`,{method:'POST',headers,body:input,signal:controller.signal,redirect:'error'}),deadline]);
 if(!response.ok){void response.body?.cancel();return json({error:'voice_provider_unavailable'},502);}
 const max=transcription?65536:MAX;if(Number(response.headers.get('content-length'))>max)throw new Error('response_too_large');
 const reader=response.body?.getReader();if(!reader)throw new Error('empty_response');let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>max)throw new Error('response_too_large');chunks.push(value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
 if(!authorized())return json({error:'unauthorized'},401);if(controller.signal.aborted)throw new Error('aborted');const bytes=Buffer.concat(chunks,size);
 if(transcription){const value=JSON.parse(bytes.toString('utf8'));if(typeof value.text!=='string'||value.text.length>16000)throw new Error('invalid_response');return json({text:value.text});}
 if(!bytes.length||!(response.headers.get('content-type')??'').startsWith('audio/'))throw new Error('invalid_response');return new Response(bytes,{headers:{'Content-Type':'audio/mpeg','Content-Length':String(size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }catch(error){if(!authorized())return json({error:'unauthorized'},401);const code=error instanceof Error?error.message:'';if(['json_required','body_too_large','body_timeout','body_aborted','invalid_body'].includes(code))return json({error:code},code==='json_required'?415:code==='body_too_large'?413:code==='body_timeout'?408:400);return json({error:controller.signal.aborted?'voice_timeout':'voice_failed'},controller.signal.aborted?408:502);
 }finally{clearTimeout(timer);req.signal.removeEventListener('abort',abort);controller.abort();active.delete(owner);}
}
