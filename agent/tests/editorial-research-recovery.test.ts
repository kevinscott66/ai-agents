import {test,expect} from 'bun:test';
import {editorialCatalog} from '../lib/codex-editorial.ts';
import {parseProblems,verdictFrom,factCheckPrompt,quotedFragments,fullText} from '../lib/fact-check.ts';
import {activitySources,checkActivity,checkEntry,editorialPrompt,askChecked,publicationSubject} from '../tools/site-editorial.ts';

test('editorial tool mode exposes hosted search with the code host disabled without changing other models',()=>{
 const catalog={models:[{slug:'requested',supported_in_api:true,tool_mode:'code_mode_only',apply_patch_tool_type:'freeform'},
  {slug:'other',supported_in_api:true,tool_mode:'code_mode_only'}]};
 const result=editorialCatalog(JSON.stringify(catalog),'requested');
 expect(result.model).toBe('requested');
 expect(result.catalog.models[0].tool_mode).toBe('direct');
 expect(result.catalog.models[0].apply_patch_tool_type).toBeNull();
 expect(result.catalog.models[1].tool_mode).toBe('code_mode_only');
 expect(catalog.models[0].tool_mode).toBe('code_mode_only');
 expect(()=>editorialCatalog(JSON.stringify(catalog),'unavailable')).toThrow();
});

test('real verifier text-shaped complaint is retained, not silently dropped',()=>{
 const message='Не подтверждено официальное авторство аккаунта';
 const v=verdictFrom({problems:[{text:message,severity:'block'}],sources_opened:['https://example.com']},[],
  {title:'Проект открыл программу',items:[{text:'source',url:'https://example.com'}]});
 expect(v.problems).toHaveLength(1);
 expect(v.problems[0].issue).toBe(message);
 expect(v.problems[0].severity).toBe('block');
 expect(parseProblems({problems:[{claim:'Season 1',reason:message,severity:'block'}]})[0].issue).toBe(message);
 expect(parseProblems({problems:[{claim:'Mainnet',explanation:message,severity:'block'}]})[0].issue).toBe(message);
});

test('missing or malformed complaints fail closed, a valid empty list passes',()=>{
 for(const parsed of [{},{problems:{}},{problems:[null]},{problems:['block']},{problems:[{claim:'Unsupported claim',severity:'warn'}]}]) {
  expect(parseProblems(parsed).some(p=>p.severity==='block')).toBe(true);
 }
 expect(parseProblems({problems:[]})).toEqual([]);
 expect(parseProblems({problems:[{claim:'x',issue:'y',severity:'warn'}]})[0].severity).toBe('warn');
});

test('activity primary announcements in intro and steps reach source selection without adding arbitrary fetch URLs',()=>{
 const post='https://x.com/TryNoahAI/status/2112560147595960777';
 const a={id:'noah',title:'Original title',url:'https://trynoah.ai/quests',intro:`Season 0 [начался](${post}). [local](http://127.0.0.1/secret)`,
  steps:[`[анонс](${post})`,`[unrelated](https://evil.example/redirect)`]};
 expect(activitySources(a).map(s=>s.url)).toEqual([a.url,post]);
 expect(activitySources({...a,url:undefined,intro:'',steps:[]})).toEqual([]);
 expect(activitySources({...a,steps:Array.from({length:12},(_,i)=>`[post](https://x.com/Project/status/1234567${i})`)})).toHaveLength(8);
});

test('concrete defer reason is bounded, single-line and sent back into the next attempt',async()=>{
 const row={id:'story',title:'Original'};
 const deferred={defer:true,reason:'Источник не доступен\nнужно проверить автора'};
 const error=checkEntry(deferred as any,row);
 expect(error.join()).toContain('нужно проверить автора');
 expect(error.join()).not.toContain('\n');
 expect(checkActivity(deferred as any,row)).toEqual(error);
 expect(checkEntry({defer:true,reason:'x'.repeat(2000)} as any,row).join().length).toBeLessThan(720);
 let attempt=0;
 await expect(askChecked('source',p=>checkEntry(p as any,row),{},async(prompt)=>{
  if(++attempt===2)expect(prompt).toContain('нужно проверить автора');
  return JSON.stringify(deferred);
 })).rejects.toThrow('нужно проверить автора');
});

test('archival review keeps historical event dates instead of requiring a second launch',()=>{
 const prompt=editorialPrompt({id:'old',title:'Old announcement',date:'2026-05-15'},[]);
 expect(prompt).toContain('Редактура архивной новости не требует нового события');
 expect(prompt).toContain('не изображай старые условия действующими сейчас');
 expect(factCheckPrompt({title:'A historical announcement',date:'2026-05-15',requireEvent:true})).toContain('event_supported');
});
test('activity verification includes retained rewards and steps so a corrected intro cannot hide contradictions',()=>{
 const raw={id:'metric',title:'Old title',intro:'Old intro',rewardType:'Поинты',spent:'$1+',time:'20 мин',steps:['Внести реальные средства в пул']};
 const proposed={title:'Metric запустил обмены токенов и пулы ликвидности',intro:'Награда не подтверждена.'};
 const subject=publicationSubject(proposed,raw,'activities');
 expect(subject.body).toContain('Награда не подтверждена.');
 expect(subject.body).toContain('Поинты');expect(subject.body).toContain('$1+');
 expect(subject.body).toContain(raw.steps[0]);expect(subject.requireEvent).toBe(false);
 expect(quotedFragments(fullText(subject))).toEqual([]); // Metadata JSON must not invent direct speech.
 expect(subject.body).toContain('Оценка времени редакцией:');
 expect(raw.intro).toBe('Old intro');expect(proposed.intro).toBe('Награда не подтверждена.');
 expect(publicationSubject(proposed,{...raw,intro:undefined},'activities').requireEvent).toBe(false);
});
