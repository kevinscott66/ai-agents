import {expect,test} from 'bun:test';
import {readFileSync,mkdtempSync,rmSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dailySourceFetch,acquireDraftLock,releaseDraftLock,DRAFT_LOCK_MAX_AGE_MS,researchArticles,recentPublishedTitles,recentChannelTitles,channelTitles,primarySourceLink,buildPreviewText,type DraftArticle} from '../tools/daily-draft.ts';
import {buildFinalText,runPublicationLocked} from '../tools/approve-poll.ts';
import {verdictFrom,factCheckPrompt,type Checkable} from '../lib/fact-check.ts';

const now=Date.parse('2026-10-29T16:00:00Z');
const article=(name='Example'):DraftArticle=>({title:`${name} открыл тестирование нового продукта для разработчиков в открытой программе`,date:'2026-10-29',
 summary:'Команда опубликовала **условия тестирования** нового продукта для разработчиков. Участникам доступна документация с описанием возможностей, поддерживаемых сценариев работы и ограничений текущей версии.',
 body:Array.from({length:2},()=>('Команда открыла тестирование продукта и опубликовала документацию. Разработчики могут изучить возможности и условия доступа. ').repeat(3).trim()).join('\n\n'),
 items:[{text:'Официальный анонс',url:'https://example.com/announcement?referral=code'},{text:'Независимое издание',url:'https://example.net/news'}],sourceCount:2});
const ask=(articles:DraftArticle[])=>async()=>JSON.stringify({articles});
const passed=()=>({opened:2,problems:[],at:new Date(now).toISOString()});

test('daily publisher uses the new public catalog; failed/malformed catalog does not erase duplicate history',async()=>{
 let called='';
 const titles=await recentPublishedTitles((async url=>{called=String(url);return Response.json([
  {kind:'project',title:'Not news',date:'2026-10-29'},
  {kind:'digest',title:'Yesterday',date:'2026-10-28'},
  {kind:'digest',title:'Today\nheadline',date:'2026-10-29'},
 ]);}) as typeof fetch);
 expect(called).toEndWith('/api/catalog');expect(titles).toEqual(['Today headline','Yesterday']);
 for(const response of [new Response(null,{status:503}),Response.json({items:[]})]) {
  await expect(recentPublishedTitles((async()=>response) as unknown as typeof fetch)).rejects.toThrow();
 }
});

test('channel history dedup uses recent UTF-16 bold headings without merging unrelated paragraphs',()=>{
 const text='📰 Новости\n\nAlpha открыл продукт\nПервый абзац.\nOmega снизил комиссию';
 const head='Alpha открыл продукт',next='Omega снизил комиссию';
 const entities=[head,next].map(s=>({className:'MessageEntityBold',offset:text.indexOf(s),length:s.length}));
 expect(channelTitles([{date:now/1000,message:text,entities}],now)).toEqual([head,next]);
 expect(channelTitles([{date:(now-49*3600000)/1000,message:text,entities}],now)).toEqual([]);
});

test('one-shot channel reader destroys its client after successful and failed reads, leaving no background ping loop',async()=>{
 for (const fail of [false,true]) {
  let destroyed=0;
  const client={connect:async()=>{},getEntity:async()=>({id:'4471352065',broadcast:true,creator:true}),
   getMessages:async()=>{if(fail)throw Error('network unavailable');return [];},destroy:async()=>{destroyed++;}} as any;
  if(fail)await expect(recentChannelTitles(client)).rejects.toThrow();
  else expect(await recentChannelTitles(client)).toEqual([]);
  expect(destroyed).toBe(1);
 }
});

test('independent checker sees final cleaned content and a bounded event window, not the writer context',async()=>{
 let calls=0;
 const result=await researchArticles([],{now,ask:ask([article()]),verify:async c=>{
  calls++;expect(c.requireEvent).toBe(true);expect(c.requireIndependentSources).toBe(true);expect(c.eventWindow).toEqual({from:'2026-10-28',to:'2026-10-29'});
  expect(c.items?.[0].url).toBe('https://example.com/announcement');
  expect(c.title).toBe(article().title);return passed();
 }});
 expect(calls).toBe(1);expect(result).toHaveLength(1);expect(result[0].items[0].url).not.toContain('referral');
});

test('writer and verifier share the captured UTC day at the year and timezone boundary',async()=>{
 for (const instant of ['2026-12-31T23:59:59.999Z','2027-01-01T00:00:00.001Z','2027-01-01T00:30:00+03:00']) {
  const clock=Date.parse(instant),today=new Date(clock).toISOString().slice(0,10);
  const a={...article(),date:today};let checked=0;
  const result=await researchArticles([],{now:clock,ask:async(_system,prompt)=>{
   expect(prompt).toContain(`Сегодня ${today} (UTC)`);
   expect(prompt).toContain(`"date":"${today}"`);
   return JSON.stringify({articles:[a]});
  },verify:async c=>{
   checked++;expect(c.eventWindow).toEqual({from:new Date(clock-86400000).toISOString().slice(0,10),to:today});return passed();
  }});
  expect(checked).toBe(1);expect(result[0].date).toBe(today);
 }
});

test('malformed initial and repaired responses cannot reach verification or create a draft',async()=>{
 for (const response of ['{"articles":null}','{"articles":{}}','{"articles":[]','No JSON']) {
  let calls=0;
  await expect(researchArticles([],{now,ask:async()=>response,verify:async()=>{calls++;return passed();}})).rejects.toThrow();
  expect(calls).toBe(0);
 }
 let writes=0,checks=0;
 await expect(researchArticles([],{now,ask:async()=>++writes===1?JSON.stringify({articles:[article()]}):'{"articles":null}',
  verify:async()=>{checks++;return {...passed(),problems:[{claim:'claim',issue:'unsupported',severity:'block'}]};}})).rejects.toThrow('No fresh');
 expect(writes).toBe(2);expect(checks).toBe(1);
});

test('all-rejected and zero-open-source runs never produce a draft; fewer confirmed stories are allowed',async()=>{
 for(const verdict of [{...passed(),opened:0},{...passed(),problems:[{claim:'reward',issue:'unsupported reward',severity:'block' as const}]}]) {
  await expect(researchArticles([],{now,ask:ask([article()]),verify:async()=>verdict})).rejects.toThrow('No fresh');
 }
 const other={...article('Omega'),title:'Omega снизил комиссию переводов своего токена до одного цента для всех пользователей'};
 const result=await researchArticles([],{now,ask:ask([article('Alpha'),other]),verify:async c=>
  c.title.startsWith('Alpha')?passed():{...passed(),problems:[{claim:'x',issue:'unknown',severity:'block'}]}});
 expect(result.map(a=>a.title)).toEqual([article('Alpha').title]);
});

test('only one editorial repair per edition is allowed and revised text must pass a separate verification',async()=>{
 let writes=0,checks=0;
 const rejected={...passed(),problems:[{claim:'forecast',issue:'unsupported forecast must be removed',severity:'block' as const}]};
 const fixed={...article(),body:Array.from({length:2},()=>('Подтверждённые условия тестирования продукта опубликованы командой. ').repeat(6).trim()).join('\n\n')};
 const result=await researchArticles([],{now,ask:async(_system,prompt)=>{
  writes++;
  if(writes===2){expect(prompt).toContain('unsupported forecast must be removed');return JSON.stringify({articles:[fixed]});}
  return JSON.stringify({articles:[article()]});
 },verify:async c=>{checks++;return c.body===fixed.body?passed():rejected;}});
 expect(writes).toBe(2);expect(checks).toBe(2);expect(result[0].body).toBe(fixed.body);
 writes=0;checks=0;
 await expect(researchArticles([],{now,ask:async()=>{writes++;return JSON.stringify({articles:[article()]});},
  verify:async()=>{checks++;return rejected;}})).rejects.toThrow('No fresh');
 expect(writes).toBe(2);expect(checks).toBe(2);
});

test('TZ format and factual corrections share one bounded repair and never bypass verification',async()=>{
 let asks=0,checks=0;const valid=article();
 const result=await researchArticles([],{now,ask:async()=>{asks++;return JSON.stringify({articles:[asks===1?{...valid,summary:valid.summary.replaceAll('**','')}:valid]});},verify:async()=>{checks++;return passed();}});
 expect(asks).toBe(2);expect(checks).toBe(1);expect(result).toHaveLength(1);
});

test('stale, future, invalid and missing dates cannot become today; duplicates never reach the verifier',async()=>{
 for(const date of ['2026-10-26','2026-10-27','2026-10-30','2026-02-31','', 'not-a-date']) {
  let checked=false;
  await expect(researchArticles([],{now,ask:ask([{...article(),date}]),verify:async()=>{checked=true;return passed();}})).rejects.toThrow();
  expect(checked).toBe(false);
 }
 let checked=false;
 await expect(researchArticles([article().title],{now,ask:ask([article()]),verify:async()=>{checked=true;return passed();}})).rejects.toThrow();
 expect(checked).toBe(false);
});

test('model-supplied private source destinations are rejected before research verification or publication',async()=>{
 for(const url of ['http://127.0.0.1/admin','http://169.254.169.254/latest/meta-data','http://[::1]/','http://private.local/']) {
  let called=false;
  await expect(researchArticles([],{now,ask:ask([{...article(),items:[{text:'Source',url}]}]),verify:async()=>{called=true;return passed();}})).rejects.toThrow();
  expect(called).toBe(false);
 }
});

test('a supported old announcement cannot pass the fresh-event gate, while normal archive checks are unchanged',()=>{
 const c:Checkable={title:'Product announcement',requireEvent:true,eventWindow:{from:'2026-12-31',to:'2027-01-02'},items:[{text:'source',url:'https://example.com'}]};
 const parsed={problems:[],sources_opened:['https://example.com'],event_supported:true,event_evidence_url:'https://example.com'};
 for(const event_date of [null,'2026-12-30','2027-01-03','2026-02-31']) expect(verdictFrom({...parsed,event_date},[],c).problems.some(x=>x.where==='date')).toBe(true);
 expect(verdictFrom({...parsed,event_date:'2027-01-01'},[],c).problems).toEqual([]);
 expect(verdictFrom(parsed,[],{...c,eventWindow:undefined}).problems).toEqual([]);
 expect(factCheckPrompt(c)).toContain('Окно свежести события');
});

test('preview and published digest keep a real source link; hostile URLs cannot inject links or HTML',()=>{
 const a={...article(),items:[{text:'source',url:'https://example.com/doc(a)?x=1'}]};
 const link=primarySourceLink(a.items);expect(link).toContain('doc%28a%29');
 expect(buildPreviewText([a])).toContain(link);
 const pending={createdAt:new Date(now).toISOString(),previewMsgId:1,dayTitle:'Главное за день',articles:[a]};
 const final=buildFinalText(pending);expect(final).toContain(link);expect(final).not.toContain('notion.site');
 for(const url of ['javascript:alert(1)','data:text/html,x','https://user:password@example.com','https://example.com\n[bad](javascript:1)']) {
  expect(primarySourceLink([{url}])).toBe('');
  expect(()=>buildFinalText({...pending,articles:[{...a,items:[{text:'Source',url}]}]})).toThrow();
 }
});

test('trusted source images keep binary pixels and headers with redirects forbidden',async()=>{
 const pixels=new Uint8Array([255,216,255,224]);let calls=0;
 const response=await dailySourceFetch('https://pbs.twimg.com/media/example.jpg',{signal:AbortSignal.timeout(8000)},
  (async(_url,opts)=>{calls++;expect(opts?.redirect).toBe('error');return new Response(pixels,{headers:{'content-type':'image/jpeg'}});}) as unknown as typeof fetch);
 expect(calls).toBe(1);expect(response.headers.get('content-type')).toBe('image/jpeg');
 expect(new Uint8Array(await response.arrayBuffer())).toEqual(pixels);
 await expect(dailySourceFetch('http://127.0.0.1/private')).rejects.toThrow();
});

test('stale lock recovery uses a separate exclusive gate and never overwrites a new owner',()=>{
 const dir=mkdtempSync(join(tmpdir(),'daily-stale-lock-')),path=join(dir,'lock');
 try{
  writeFileSync(path,`${now-DRAFT_LOCK_MAX_AGE_MS-1}:old`);mkdirSync(path+'.reclaim');
  expect(acquireDraftLock(path,now,'contender')).toBeNull();
  expect(readFileSync(path,'utf8')).toEndWith(':old');
  rmSync(path+'.reclaim',{recursive:true});
  const first=acquireDraftLock(path,now,'first');expect(first).toBe(`${now}:first`);
  expect(acquireDraftLock(path,now,'second')).toBeNull();
  expect(readFileSync(path,'utf8')).toBe(first!);releaseDraftLock(path,first);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('daily service runs the pinned Codex transport, retains restricted permissions and fits the lock lifetime',()=>{
 const service=readFileSync(new URL('../../deploy/systemd/delabs-daily-draft.service',import.meta.url),'utf8');
 expect(service).toContain('CODEX_AUTH_HOME=/var/lib/agent-codex');expect(service).not.toContain('Environment=CLAUDE_BIN');
 expect(service).toContain('ExecStart=/usr/bin/flock -w 1800 /var/lib/delabs-editorial/research.lock');
 expect(service).toContain('/var/lib/agent-codex /var/lib/delabs-editorial/research.lock');
 expect(DRAFT_LOCK_MAX_AGE_MS).toBeGreaterThan(Number(service.match(/TimeoutStartSec=(\d+)/)?.[1])*1000);
 expect(service).toContain('ProtectSystem=strict');expect(service).toContain('DELABS_CHANNEL_ID=-1004471352065');
 const source=readFileSync(new URL('../tools/daily-draft.ts',import.meta.url),'utf8');
 expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
});

test('concurrent automatic publishers cannot read and deliver the same pending twice; failures release their lock',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'channel-publisher-'));const path=join(dir,'publish.lock');
 let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});let sends=0,reads=0;
 try {
  const first=runPublicationLocked(async()=>{reads++;await waiting;sends++;},path);
  expect(await runPublicationLocked(async()=>{reads++;sends++;},path)).toBe(false);
  expect(reads).toBe(1);release();expect(await first).toBe(true);expect(sends).toBe(1);
  await expect(runPublicationLocked(async()=>{throw Error('render failed before send');},path)).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
 } finally {release();rmSync(dir,{recursive:true,force:true});}
});
