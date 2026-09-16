const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function harness(){
  const elements=new Map(), events={}, timers=new Map();let timerId=0;
  const element=()=>({disabled:false,hidden:false,value:'',textContent:'',children:[],dataset:{},scrollHeight:0,scrollTop:0,clientHeight:0,open:false,classList:{toggle(){},remove(){}},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},setAttribute(){},addEventListener(){},querySelector(){return element();},showModal(){this.open=true;},close(){this.open=false;},getContext(){return {clearRect(){},createRadialGradient(){return {addColorStop(){}};},beginPath(){},arc(){},fill(){}};}});
  const context=vm.createContext({console,AbortController,DOMException,Blob,Uint8Array,Float32Array,performance:{now:()=>2000},matchMedia:()=>({matches:false}),setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},setInterval(){},requestAnimationFrame(){return 1;},cancelAnimationFrame(){},URL:{createObjectURL:()=>'',revokeObjectURL(){}},crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},btoa:s=>Buffer.from(s,'binary').toString('base64'),window:{isSecureContext:true,addEventListener(name,fn){events[name]=fn;}},document:{hidden:false,body:element(),getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,createTextNode:text=>text,addEventListener(name,fn){events[name]=fn;}},navigator:{mediaDevices:{getUserMedia:async()=>{throw Error('not mocked');}}},MediaRecorder:class{static isTypeSupported(){return true;}},fetch:async()=>{throw Error('unexpected fetch');}});
  vm.runInContext(fs.readFileSync(__dirname+'/app.js','utf8'),context);
  return {context,elements,events,timers,run:code=>vm.runInContext(code,context)};
}
test('closing voice prevents recorder onstop from submitting and cleans every resource',()=>{
  const h=harness();h.run(`let stopped=0,paused=0,closed=0; voice={controller:new AbortController(),stream:{getTracks:()=>[{stop(){stopped++;}}]},context:{close(){closed++;return Promise.resolve();}},audio:{pause(){paused++;}},recorder:{state:'recording',stop(){ if(voice) throw Error('voice still active');}}}; const old=voice;stopVoice();`);
  assert.equal(h.run('voice'),null);assert.equal(h.run('old.controller.signal.aborted'),true);assert.equal(h.run('stopped+paused+closed'),3);
});
test('VAD submits only after detected speech then 1200ms silence',()=>{
  const h=harness();h.run(`let recordingStops=0;voice={phase:'listening',heard:false,lastSound:0,input:{fftSize:4,getFloatTimeDomainData(a){a.fill(0);}},stream:{getAudioTracks:()=>[{enabled:true}]},recorder:{stop(){recordingStops++;}}};drawOrb(voice);`);
  assert.equal(h.run('recordingStops'),0);
  h.run('voice.heard=true;voice.lastSound=900;drawOrb(voice)');assert.equal(h.run('recordingStops'),0);
  h.run('voice.lastSound=700;drawOrb(voice)');assert.equal(h.run('recordingStops'),1);assert.equal(h.run('voice.phase'),'transcribing');
});
test('late microphone permission cannot revive a closed session',async()=>{
  const h=harness();h.run(`let resolveMic,trackStops=0; AudioContext=class{resume(){return Promise.resolve();}close(){return Promise.resolve();}};window.MediaRecorder=MediaRecorder;navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{resolveMic=resolve;});fetch=async()=>({ok:true,json:async()=>({available:true})});token='test';`);
  const start=h.elements.get('voice').onclick();
  for(let i=0;i<8;i++)await Promise.resolve();
  h.run('stopVoice();resolveMic({getTracks:()=>[{stop(){trackStops++;}}]})');await start;
  assert.equal(h.run('trackStops'),1);assert.equal(h.run('voice'),null);
});
test('uncertain turn POST is never replayed and draft remains intact',async()=>{
  const h=harness();h.run(`token='test';chat='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';let calls=0;fetch=async()=>{calls++;throw Error('network lost');};$('draft').value='hello';`);
  await h.run("send('hello')");assert.equal(h.run('calls'),1);assert.equal(h.run("$('draft').value"),'hello');assert.equal(h.run('sending'),false);
});
test('backgrounding stops microphone and disconnect clears memory credential',()=>{
  const h=harness();h.run(`token='test';voice={controller:new AbortController()};document.hidden=true;`);h.events.visibilitychange();assert.equal(h.run('voice'),null);
  h.events.pagehide();assert.equal(h.run('token'),'');
});
test('server running state and local submission independently block send',()=>{
  const h=harness();h.run("token='test';busy=false;sending=true;controls()");assert.equal(h.elements.get('send').disabled,true);
  h.run('sending=false;busy=true;controls()');assert.equal(h.elements.get('send').disabled,true);
});
test('first voice turn creates a chat without closing its own session',async()=>{
  const h=harness();h.run(`token='test';let turnPosts=0;const v={controller:new AbortController()};voice=v;speak=async()=>{};fetch=async(url,options)=>{let data={};if(url.endsWith('/conversations'))data=options.method==='POST'?{conversation:{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'New'}}:{conversations:[],running:false};else if(url.endsWith('/approvals'))data={approvals:[]};else if(url.endsWith('/turns')){if(options.signal.aborted)throw Error('aborted');turnPosts++;data={status:'done',replies:['hello']};}else data={messages:[],running:false,more:false};return {ok:true,json:async()=>data};};`);
  await h.run("send('voice transcript',v)");assert.equal(h.run('turnPosts'),1);assert.equal(h.run('voice===v'),true);assert.equal(h.run('v.controller.signal.aborted'),false);
});
test('voice cannot start with an unsent text draft',async()=>{
  const h=harness();h.run("token='test';$('draft').value='unsent';controls()");assert.equal(h.elements.get('voice').disabled,true);
  await h.elements.get('voice').onclick();assert.equal(h.run('voice'),null);assert.equal(h.run("$('draft').value"),'unsent');
});
test('speech chunks preserve the complete text and Unicode without exceeding provider limit',()=>{
  const h=harness();h.context.sample=('Большой ответ. 😀 Ещё предложение!\n').repeat(240);
  const result=h.run('speechChunks(sample,2000)');assert.equal(result.join(''),h.context.sample);assert.ok(result.length>1);
  for(const chunk of result){assert.ok(chunk.length<=4000);assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk));}
});
test('interrupt stops playback and prevents later speech chunks from being requested',async()=>{
  const h=harness();h.run(`let speechCalls=0,plays=0;Audio=class{pause(){}play(){plays++;return Promise.resolve();}};fetch=async()=>{speechCalls++;return {ok:true,blob:async()=>new Blob(['audio'])};};const v={controller:new AbortController(),maxTextLength:8,context:{resume:async()=>{},createAnalyser:()=>({connect(){},disconnect(){}}),createMediaElementSource:()=>({connect(){},disconnect(){}})}};voice=v;listen=value=>{value.phase='listening';};`);
  const speaking=h.run("speak('one two three four five six seven',v)");
  for(let i=0;i<15;i++)await Promise.resolve();
  assert.equal(h.run('plays'),1);h.elements.get('interrupt').onclick();await assert.rejects(speaking,{name:'AbortError'});
  assert.equal(h.run('speechCalls'),1);assert.equal(h.run('v.phase'),'interrupted');
});
test('interrupt aborts a pending second TTS request before send unwinds and mic resumes',async()=>{
  const h=harness();h.run(`token='test';chat='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';let speechCalls=0,micStarts=0,secondSignal;const v={controller:new AbortController(),maxTextLength:8,maxAudioBytes:1000,context:{resume:async()=>{},createAnalyser:()=>({connect(){},disconnect(){}}),createMediaElementSource:()=>({connect(){},disconnect(){}})}};voice=v;listen=value=>{if(sending)throw Error('microphone resumed during send');micStarts++;value.phase='listening';};Audio=class{pause(){}play(){return Promise.resolve();}};fetch=async(url,options)=>{let data={};if(url.endsWith('/voice/speech')){speechCalls++;if(speechCalls===1)return {ok:true,blob:async()=>new Blob(['audio'])};secondSignal=options.signal;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));}if(url.endsWith('/voice/transcribe'))data={text:'hello'};else if(url.endsWith('/turns'))data={status:'done',replies:['one two three four five six seven']};else if(url.endsWith('/approvals'))data={approvals:[]};else if(url.endsWith('/conversations'))data={conversations:[],running:false};else data={messages:[],running:false};return {ok:true,json:async()=>data};};`);
  const operation=h.run("transcribe(v,new Blob(['recording']))");
  for(let i=0;i<100;i++)await Promise.resolve();
  h.run('v.audio.onended()');for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(h.run('speechCalls'),2);assert.equal(h.run('sending'),true);
  h.elements.get('interrupt').onclick();assert.equal(h.run('secondSignal.aborted'),true);assert.equal(h.run('micStarts'),0);
  await operation;assert.equal(h.run('sending'),false);assert.equal(h.run('micStarts'),1);assert.equal(h.run('v.controller.signal.aborted'),false);
});
