'use strict';
const $ = id => document.getElementById(id);
let catalogTick = 0;
let token = '', chat = '', cursor = null, messages = [], busy = false, sending = false, syncing = false, session = 0;
const requests = new Set();
const decisions = new Map();
const notice = text => { $('notice').textContent = text; };
async function api(path, body, binary = false, signal) {
  const controller = new AbortController(); requests.add(controller);
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 90000);
  try {
    const response = await fetch('/api/web/' + path, {method:body === undefined?'GET':'POST', credentials:'omit', cache:'no-store', redirect:'error', headers:{...(token?{Authorization:'Bearer '+token}:{}), ...(body===undefined?{}:{'Content-Type':'application/json'})}, body:body===undefined?undefined:JSON.stringify(body), signal:controller.signal});
    if (!response.ok) {
      const error = await response.json().catch(()=>({}));
      if (response.status === 401 && token) disconnect();
      throw new Error(error.error || 'Ошибка сервера: '+response.status);
    }
    return binary ? response.blob() : response.json();
  } finally { clearTimeout(timeout); requests.delete(controller); signal?.removeEventListener('abort',abort); }
}
function controls() {
  $('draft').disabled = !token || !!voice; $('send').disabled = !token || busy || sending || !!voice;
  $('new-chat').disabled = !token || busy || sending || !!voice;
  $('voice').disabled = !token || busy || sending || !!voice || !!$('draft').value.trim();
}
function disconnect() {
  session++; stopVoice(); token=''; chat=''; messages=[]; busy=false; sending=false;
  for (const request of requests) request.abort();
  $('messages').replaceChildren(); $('chats').replaceChildren(); $('approvals').replaceChildren(); decisions.clear(); $('pairing').hidden=false;
  $('disconnect').hidden=true; $('older').hidden=true; $('more-chats').hidden=true;
  $('connection').textContent='Не подключён'; $('draft').value=''; controls();
}
function renderMessages() {
  const container=$('messages'); const atBottom=container.scrollHeight-container.scrollTop-container.clientHeight<100;
  container.replaceChildren(...messages.map(message=>{
    const item=document.createElement('article'); item.className='message '+(message.role==='user'?'user':'assistant');
    const author=document.createElement('span'); author.className='author'; author.textContent=message.role==='user'?'Вы':(message.agentKey || 'Агент');
    item.append(author,document.createTextNode(message.text));
    if (message.attachments?.length) { const info=document.createElement('p'); info.textContent='Вложения: '+message.attachments.map(a=>a.name||'файл').join(', '); item.append(info); }
    return item;
  }));
  if(atBottom) container.scrollTop=container.scrollHeight;
}
async function catalog(append=false) {
  const generation=session;
  const data=await api('conversations'+(append&&cursor?'?cursor='+encodeURIComponent(cursor):''));
  if(generation!==session) return;
  busy=data.running; controls(); cursor=data.nextCursor; $('more-chats').hidden=!data.more;
  if(!append) $('chats').replaceChildren();
  for(const entry of data.conversations) {
    const button=document.createElement('button'); button.textContent=entry.title; button.dataset.id=entry.id; button.setAttribute('aria-current',String(chat===entry.id));
    button.onclick=()=>selectChat(entry.id,entry.title).catch(error=>notice(error.message)); $('chats').append(button);
  }
  if(!chat && data.conversations.length) await selectChat(data.conversations[0].id,data.conversations[0].title);
}
async function history(older=false) {
  if(!chat) return;
  const selected=chat, generation=session;
  const data=await api('conversations/'+selected+(older&&messages.length?'?before='+messages[0].seq:''));
  if(chat!==selected||session!==generation) return;
  messages=older?[...data.messages,...messages]:[...messages.filter(m=>data.messages.length&&m.seq<data.messages[0].seq),...data.messages]; busy=data.running;
  $('older').hidden=!data.more; renderMessages(); controls(); await approvals(selected,generation);
}
async function approvals(selected,generation) {
  try {
    const data=await api('conversations/'+selected+'/approvals');
    if(chat!==selected||session!==generation)return;
    $('approvals').replaceChildren();
    for(const item of data.approvals.filter(item=>item.status==='pending')){
      const card=document.createElement('article');card.className='approval';
      const title=document.createElement('strong');title.textContent='Подтверждение: '+item.action_type;
      const details=document.createElement('pre');details.textContent=JSON.stringify(item.payload,null,2);
      const state=document.createElement('p');state.textContent=decisions.get(item.id)||'Проверьте действие перед подтверждением.';
      card.append(title,details,state);
      if(!decisions.has(item.id)&&!item.redacted){
        for(const [label,decision] of [['Отклонить','rejected'],['Подтвердить','approved']]){
          const button=document.createElement('button');button.textContent=label;
          button.onclick=async()=>{
            if(decisions.has(item.id))return;
            decisions.set(item.id,'Решение отправляется…');
            for(const control of card.querySelectorAll('button'))control.disabled=true;
            state.textContent=decisions.get(item.id);
            try {
              await api('approvals/'+encodeURIComponent(item.id)+'/decide',{decision});
              if(session!==generation)return;
              decisions.set(item.id,'Решение принято.');card.remove();await history();
            }catch(error){
              if(session!==generation)return;
              const text='Не удалось подтвердить результат отправки. Решение повторно не отправлено. Обновите историю и проверьте состояние.';
              decisions.set(item.id,text);state.textContent=text;notice(text);
            }
          };
          card.append(button);
        }
      }
      $('approvals').append(card);
    }
  }catch(error){if(chat===selected&&session===generation){$('approvals').replaceChildren();if(error.message!=='forbidden')notice('Подтверждения недоступны: '+error.message);}}
}
async function selectChat(id,title,preserveVoice) {
  if(voice && voice!==preserveVoice) stopVoice(); chat=id; messages=[]; $('title').textContent=title;
  for(const button of $('chats').children) button.setAttribute('aria-current',String(button.dataset.id===id));
  document.body.classList.remove('sidebar-open'); await history(); $('messages').scrollTop=$('messages').scrollHeight;
}
async function newChat(preserveVoice) {
  const data=await api('conversations',{id:crypto.randomUUID(),title:'Новый чат'});
  await selectChat(data.conversation.id,data.conversation.title,preserveVoice); await catalog();
}
const wait = (ms,signal) => new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Остановлено','AbortError'));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted) abort();
});
async function send(text, voiceSession) {
  if(busy || sending || !text.trim()) return;
  const generation=session; sending=true; controls(); notice('Агент отвечает…');
  try {
    if(!chat) await newChat(voiceSession);
    const target=chat, id=crypto.randomUUID();
    let result=await api('turns',{id,text,conversationId:target},false,voiceSession?.controller.signal);
    if(generation!==session) return;
    if(!voiceSession && $('draft').value===text)$('draft').value=''; await history();
    // Poll an accepted job only. Never resubmit after a network interruption.
    const deadline=Date.now()+15*60*1000;
    while(result.status==='running') {
      if(Date.now()>deadline) throw new Error('Ответ ещё выполняется. История продолжит обновляться; запрос повторно не отправлен.');
      await wait(1300,voiceSession?.controller.signal);
      if(generation!==session) return;
      result=await api('turns/'+id,undefined,false,voiceSession?.controller.signal);
      if(chat===target) await history();
    }
    if(generation!==session) return;
    await history(); await catalog(); notice(result.status==='error'?'Запрос прерван. Проверьте историю перед повтором.':'');
    if(voiceSession && voice===voiceSession && result.status==='done') await speak(result.replies.join('\n'),voiceSession);
  } catch(error) {
    if(error.name!=='AbortError') {
      notice(error.message+' Проверьте историю перед повторной отправкой.');
      if(voiceSession && voice===voiceSession) voiceError(error,voiceSession);
    }
  } finally { if(generation===session) {sending=false;controls();} }
}
$('pair-form').onsubmit=async event=>{
  event.preventDefault(); const button=event.currentTarget.querySelector('button'); button.disabled=true;
  try { const paired=await api('pair',{code:$('code').value.trim()}); token=paired.token; session++; $('code').value=''; $('pairing').hidden=true; $('disconnect').hidden=false; $('connection').textContent='Подключён'; notice(''); controls(); await catalog(); }
  catch(error){notice('Не удалось подключиться: '+error.message);} finally{button.disabled=false;}
};
$('composer').onsubmit=event=>{event.preventDefault(); if(!voice) void send($('draft').value);};
$('draft').oninput=controls;
$('draft').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('composer').requestSubmit();}};
$('new-chat').onclick=()=>newChat().catch(error=>notice(error.message));
$('more-chats').onclick=()=>catalog(true).catch(error=>notice(error.message));
$('older').onclick=()=>history(true).catch(error=>notice(error.message));
$('disconnect').onclick=disconnect;
$('menu').onclick=()=>document.body.classList.toggle('sidebar-open');
setInterval(async()=>{
  if(!token||syncing||document.hidden) return; syncing=true;
  try {if(++catalogTick % 6===0)await catalog();await history();} catch(error){if(error.name!=='AbortError')notice('История не обновилась: '+error.message);} finally{syncing=false;}
},5000);

let voice=null;
function voiceState(text){$('voice-state').textContent=text;}
function voiceError(error,v){if(voice!==v)return; const message=error.message; stopVoice(); notice('Голосовой разговор остановлен: '+message);}
function stopVoice(){
  const v=voice; voice=null;
  if(v){v.speechController?.abort();v.controller.abort();cancelAnimationFrame(v.frame);clearTimeout(v.recordTimer);if(v.recorder?.state!=='inactive')v.recorder?.stop();v.stream?.getTracks().forEach(track=>track.stop());v.audio?.pause();if(v.url)URL.revokeObjectURL(v.url);v.context?.close().catch(()=>{});}
  if($('voice-dialog').open)$('voice-dialog').close(); $('interrupt').disabled=true; controls();
}
function drawOrb(v){
  if(voice!==v)return;
  const analyser=v.phase==='speaking'?v.output:v.phase==='listening'?v.input:null;
  let rms=0;
  if(analyser){const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);rms=Math.sqrt(data.reduce((sum,n)=>sum+n*n,0)/data.length);}
  const now=performance.now();
  if(v.phase==='listening'){
    if(rms>.022){v.heard=true;v.lastSound=now;}
    if(v.heard && now-v.lastSound>1200)finishRecording(v);
  }
  const canvas=$('orb'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,400,400);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const radius=105+(reduced?0:Math.min(rms*170,45));
  const gradient=ctx.createRadialGradient(165,155,10,200,200,radius);gradient.addColorStop(0,'#d5fff5');gradient.addColorStop(.6,'#58bfae');gradient.addColorStop(1,'#276f67');
  ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(200,200,radius,0,Math.PI*2);ctx.fill();
  v.frame=requestAnimationFrame(()=>drawOrb(v));
}
function listen(v){
  if(voice!==v)return; v.phase='listening';v.heard=false;v.lastSound=performance.now();
  v.stream.getAudioTracks().forEach(track=>{track.enabled=true;});
  const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  const recorder=new MediaRecorder(v.stream,mime?{mimeType:mime}:undefined); v.recorder=recorder;v.chunks=[];v.bytes=0;
  recorder.ondataavailable=event=>{if(event.data.size){v.chunks.push(event.data);v.bytes+=event.data.size;if(v.bytes>v.maxAudioBytes)voiceError(new Error('Запись слишком длинная. Начните разговор снова.'),v);}};
  recorder.onerror=()=>voiceError(new Error('Микрофон не смог записать звук.'),v);
  recorder.onstop=()=>{if(voice===v && v.phase==='transcribing')void transcribe(v,new Blob(v.chunks,{type:recorder.mimeType}));};
  recorder.start(250);clearTimeout(v.recordTimer);v.recordTimer=setTimeout(()=>{if(voice===v&&v.phase==='listening'){if(v.heard)finishRecording(v);else voiceError(new Error('Речь не обнаружена. Проверьте микрофон и запустите разговор снова.'),v);}},45000);
  voiceState('Слушаю…');$('interrupt').disabled=true;
}
function finishRecording(v){
  if(voice!==v||v.phase!=='listening')return;
  v.phase='transcribing';clearTimeout(v.recordTimer);voiceState('Распознаю…');v.recorder.stop();
  v.stream.getAudioTracks().forEach(track=>{track.enabled=false;});
}
async function transcribe(v,blob){
  try{
    if(!blob.size||blob.size>v.maxAudioBytes)throw new Error('Запись пустая или превышает лимит.');
    const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const data=await api('voice/transcribe',{base64audio:btoa(binary),mime:blob.type},false,v.controller.signal);
    if(voice!==v)return;
    if(!data.text?.trim()){listen(v);return;}
    $('transcript').textContent=data.text;voiceState('Агент думает…');v.phase='waiting';
    await send(data.text,v);
    if(voice===v&&v.phase!=='speaking'&&v.phase!=='listening')listen(v);
  }catch(error){if(error.name!=='AbortError')voiceError(error,v);}
}
function speechChunks(text,limit) {
  const points=Array.from(text), chunks=[];
  while(points.length){
    let end=Math.min(points.length,limit);
    if(end<points.length){
      for(let i=end-1;i>Math.floor(end/2);i--){if(/[\s.!?。！？]/u.test(points[i])){end=i+1;break;}}
    }
    chunks.push(points.splice(0,end).join(''));
  }
  return chunks;
}
async function speak(text,v){
  if(voice!==v)return;
  const playback=(v.playback||0)+1;v.playback=playback;
  const controller=new AbortController();v.speechController=controller;
  const abortSpeech=()=>controller.abort();v.controller.signal.addEventListener('abort',abortSpeech,{once:true});
  if(v.controller.signal.aborted)controller.abort();
  try {
  // Count UTF-16 units conservatively: astral characters can occupy two units.
  const chunks=speechChunks(text,Math.max(1,Math.floor(v.maxTextLength/2)));
  for(const chunk of chunks){
    if(voice!==v||v.playback!==playback)return;
    v.phase='synthesizing';voiceState('Готовлю голосовой ответ…');
    const blob=await api('voice/speech',{text:chunk},true,controller.signal);
    if(voice!==v||v.playback!==playback)return;
    if(v.url)URL.revokeObjectURL(v.url);v.url=URL.createObjectURL(blob);
    const audio=new Audio(v.url);v.audio=audio;
    v.source?.disconnect();v.output?.disconnect();v.output=v.context.createAnalyser();
    v.source=v.context.createMediaElementSource(audio);v.source.connect(v.output);v.output.connect(v.context.destination);
    v.phase='speaking';voiceState('Агент говорит…');$('interrupt').disabled=false;
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{controller.signal.removeEventListener('abort',abort);audio.onended=null;audio.onerror=null;v.finishPlayback=null;};
      const finish=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(new DOMException('Остановлено','AbortError'));};
      v.finishPlayback=finish;audio.onended=finish;
      audio.onerror=()=>{cleanup();reject(new Error('Не удалось воспроизвести ответ. Он сохранён в чате.'));};
      controller.signal.addEventListener('abort',abort,{once:true});
      v.context.resume().then(()=>{if(voice===v&&v.playback===playback)return audio.play();}).catch(error=>{cleanup();reject(error);});
    });
    if(v.url){URL.revokeObjectURL(v.url);v.url=null;}
  }
  if(voice===v&&v.playback===playback)v.phase='waiting';
  } finally {v.controller.signal.removeEventListener('abort',abortSpeech);if(v.speechController===controller)v.speechController=null;}
}
$('voice').onclick=async()=>{
  if(voice||busy||sending||$('draft').value.trim())return;
  const v={controller:new AbortController(),phase:'starting',maxTextLength:4000,maxAudioBytes:8388608};voice=v;controls();$('transcript').textContent='';$('voice-dialog').showModal();voiceState('Проверяю голосовое подключение…');
  try{
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Нужен браузер с записью звука и защищённое HTTPS-подключение.');
    v.context=new AudioContext();await v.context.resume();
    const status=await api('voice/status',undefined,false,v.controller.signal);if(voice!==v)return;
    if(!status.available)throw new Error('Голосовой сервис не настроен. Текстовый чат доступен.');
    v.maxTextLength=status.maxTextLength||4000;v.maxAudioBytes=status.maxAudioBytes||8388608;
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if(voice!==v){stream.getTracks().forEach(track=>track.stop());return;}
    v.stream=stream;v.input=v.context.createAnalyser();v.context.createMediaStreamSource(stream).connect(v.input);
    stream.getAudioTracks().forEach(track=>{track.onended=()=>voiceError(new Error('Микрофон отключён.'),v);});listen(v);drawOrb(v);
  }catch(error){if(error.name!=='AbortError')voiceError(error,v);}
};
$('interrupt').onclick=()=>{const v=voice;if(v&&(v.phase==='speaking'||v.phase==='synthesizing')){v.playback=(v.playback||0)+1;v.phase='interrupted';voiceState('Останавливаю озвучку…');$('interrupt').disabled=true;v.speechController?.abort();v.audio?.pause();v.finishPlayback?.();if(v.url)URL.revokeObjectURL(v.url);v.url=null;}};
$('voice-stop').onclick=stopVoice;
$('voice-dialog').addEventListener('cancel',event=>{event.preventDefault();stopVoice();});
window.addEventListener('pagehide',disconnect);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&voice){stopVoice();notice('Голосовой разговор остановлен, пока страница скрыта.');}});
