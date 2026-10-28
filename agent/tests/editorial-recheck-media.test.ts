import {test,expect} from 'bun:test';
import {pickPending,digestReviewAfter,EDITORIAL_VERSION,withJournalEditorial,checkEntry,isEditorialMeta,type RawDigest,type EditorialEntry} from '../tools/site-editorial.ts';
import {readSources,sourceMedia,mediaProblems,verdictFrom,factCheckPrompt} from '../lib/fact-check.ts';
const now=Date.parse('2026-10-28T12:00:00Z');
const raw:RawDigest={id:'story',title:'Проект: запуск программы',date:'2026-10-24',origin:'telegram',items:[]};
const entry:EditorialEntry={title:'Проект открыл приём заявок на тестирование приложения',summary:'Подробные условия заявлены командой в официальном анонсе. Участники могут изучить их на сайте.',body:'Подтверждённый факт с полезными условиями участия. '.repeat(10),items:[],editorialVersion:2};
const empty={digests:{}};
const pending=(e:EditorialEntry,r=raw,manual=empty)=>pickPending([r],manual,{digests:{[r.id]:e}},'digests',3,{},now);

test('recent version2 copy is revisited; a successful current-policy revision does not loop',()=>{
 expect(pending(entry)).toHaveLength(1);
 const checked={...entry,editorialVersion:EDITORIAL_VERSION,reviewAfter:digestReviewAfter(entry,now)};
 expect(pending(checked)).toHaveLength(0);
 expect(pickPending([raw],empty,{digests:{story:checked}},'digests',3,{},now+86400000)).toHaveLength(1);
});
test('scheduled review also selects full API copy and respects six-hour cooldown',()=>{
 const r={...raw,origin:'api',title:entry.title,body:entry.body};
 const due={...entry,editorialVersion:EDITORIAL_VERSION,reviewAfter:new Date(now-1).toISOString()};
 expect(pending(due,r)).toHaveLength(1);
 expect(pickPending([r],empty,{digests:{story:due}},'digests',3,{'digests:story':now+100},now)).toHaveLength(0);
});
test('archive is not rewritten forever; daily actionable and weekly news schedules cross UTC/year boundaries',()=>{
 expect(pending({...entry,editorialVersion:2},{...raw,date:'2026-07-08'})).toHaveLength(0);
 expect(digestReviewAfter(entry,Date.parse('2026-12-31T23:30:00Z'))).toBe('2027-01-01T23:30:00.000Z');
 expect(digestReviewAfter({title:'Проект представил архитектуру основной сети'},now)).toBe('2026-11-04T12:00:00.000Z');
});
test('source-link headline and editorial residue fail even in a version3 long article',()=>{
 for(const changed of [
  {...entry,title:'Metric опубликовал ссылку на ресурс проекта в официальном X'},
  {...entry,body:entry.body+' В материал эти детали не вошли.'},
  {...entry,body:entry.body+' Это определение из исходного поста не используется.'},
 ]){
  expect(checkEntry(changed,raw).length).toBeGreaterThan(0);
  expect(pending({...changed,editorialVersion:EDITORIAL_VERSION,reviewAfter:new Date(now+86400000).toISOString()})).toHaveLength(1);
 }
 expect(isEditorialMeta('Команда не объявила размер награды. Точный дедлайн не назван.')).toBe(false);
});
test('live journal body is protected and later human fields take precedence without mutating snapshot',()=>{
 const manual={digests:{story:{title:'Ручной заголовок'}}};
 const merged=withJournalEditorial(manual,[{kind:'digest',op:'patch',key:'story',value:{body:'Ручной разбор',title:'Поздний заголовок'}},{kind:'activity',op:'patch',key:'story',value:{body:'Чужая сущность'}}]);
 expect(pending(entry,raw,merged as typeof empty)).toHaveLength(0);
 expect(merged.digests!.story.title).toBe('Поздний заголовок');
 expect(manual.digests.story.title).toBe('Ручной заголовок');
 expect(pending(entry,raw,withJournalEditorial(empty,[{kind:'digest',op:'patch',key:'story',value:{title:'Только заголовок'}}]) as typeof empty)).toHaveLength(1);
 expect(()=>withJournalEditorial(empty,{})).toThrow('journal');
});

const url='https://x.com/YujiKumagai/status/2113572388444987437';
const image='https://pbs.twimg.com/media/HVSKz2caUAAv0y-.jpg';
const subject={title:'В тизере Soneium показали число 26',body:'На изображении есть число 26.',items:[{text:'Тизер',url}],requireEvent:true};
test('source reader retains media from both platform formats and does not fetch supplied media URLs',async()=>{
 for(const record of [{tweet:{text:'Found this on my desk',media:{photos:[{url:image,altText:'Untrusted alt'}]}}},{text:'Found this on my desk',mediaDetails:[{type:'photo',media_url_https:image}]}]){
  const calls:string[]=[];
  const fetchImpl=(async(input:any)=>{calls.push(String(input));return String(input).includes('fxtwitter')&& !('tweet' in record)?new Response('{}',{status:404}):Response.json(record);}) as typeof fetch;
  const [source]=await readSources([{url}],fetchImpl);
  expect(source.media?.[0].url).toBe(image);
  expect(source.text).toContain('Found this on my desk');
  expect(calls.some(c=>c.startsWith('https://pbs.'))).toBe(false);
 }
 expect(sourceMedia({media:{photos:[{url:'http://127.0.0.1/private'},{url:'https://pbs.twimg.com.evil.test/x'},{url:'javascript:alert(1)'}]}})).toEqual([]);
});
test('caption-only access is not visual confirmation; uninspected necessary media fails closed',()=>{
 const read=[{url,text:'Found this on my desk',media:[{url:image,type:'image' as const}]}];
 for(const media_review of [undefined,[{url:image,status:'unavailable',reason:'Не удалось открыть картинку'}],[{url:image,status:'text_sufficient',reason:'Только подпись была доступна'}]]){
  const v=verdictFrom({problems:[],event_supported:true,event_evidence_url:url,media_review},[],subject,read);
  expect(v.problems.some(p=>p.severity==='block'&&p.issue.includes('медиа'))).toBe(true);
 }
 expect(mediaProblems({media_review:[{url:image,status:'inspected',reason:'Изображение открыто и видно число26'}]},subject,read)).toEqual([]);
 expect(mediaProblems({media_review:[{url:image,status:'text_sufficient',reason:'Точная дата и условия прямо в подписи'}]},{...subject,title:'Проект открыл регистрацию',body:'Дата и условия указаны в анонсе'},read)).toEqual([]);
 expect(factCheckPrompt(subject,read)).toContain('Медиа (ещё НЕ просмотрено)');
});

test('a retained manual source-only title cannot bypass final merged verification',async()=>{
 const {checkPublication}=await import('../tools/site-editorial.ts');
 let called=false;
 const errors=await checkPublication(entry,raw,{title:'Metric опубликовал ссылку на ресурс проекта в официальном X'},async()=>{called=true;return [];});
 expect(errors.join(' ')).toContain('итоговый заголовок');
 expect(called).toBe(false);
});
