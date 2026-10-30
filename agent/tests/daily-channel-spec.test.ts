import{test,expect}from'bun:test';
import{dailyStoryErrors,channelDailyText,fitDailyStories,sameChannelEntities,highlightedLead}from'../lib/channel-daily-spec.ts';
import{verdictFrom,factCheckPrompt}from'../lib/fact-check.ts';
import{HTMLParser}from'telegram/extensions/html';
import{mdToUserbotHtml}from'../lib/telegram-format.ts';
const story=()=>({title:'Google представила Gemini 4 Carbon для киберзащиты и долгих агентных задач',date:'2026-10-28',
summary:'**28 октября** Google представила Gemini 4 Carbon для киберзащиты и длительных агентных задач. Модель сначала получат отобранные специалисты; объявленная вводная цена — **$2** за миллион входных токенов.',
body:Array.from({length:2},()=>('Компания опубликовала условия доступа к новой модели и описала возможности продукта для разработки программного обеспечения. ').repeat(3).trim()).join('\n\n'),
items:[{text:'Официальный анонс',url:'https://example.com/announcement'},{text:'Независимое издание',url:'https://example.net/report'}],emoji:'🔥'});
test('channel TZ validates length, complete descriptions, restrained bold, sources and no AI cliches',()=>{
 expect(dailyStoryErrors(story())).toEqual([]);
 for(const changed of [{summary:'Один заголовок без описания'},{summary:story().summary.replaceAll('**','')},{body:'Короткое тело'},{items:story().items.slice(0,1)},{summary:'**'+story().summary.replaceAll('**','')+'**'},{summary:story().summary+' Это является инновацией.'},{summary:story().summary+' [Войти](javascript:alert(1))'}])expect(dailyStoryErrors({...story(),...changed}).length).toBeGreaterThan(0);
});
test('reference channel layout uses emoji stories, plain date, complete leads and real source links',()=>{
 const text=channelDailyText('Главное за день','2026-10-29T08:00:00Z',[story()]);
 const[plain,entities]=HTMLParser.parse(mdToUserbotHtml(text));
 expect(text).toContain('\n🔥 **Google');expect(text).not.toMatch(/^\d+\. /m);expect(text).toContain('**$2**');expect(text).toContain('**28 октября**');
 expect(text).not.toContain('Разделы:');expect(text).not.toContain('notion.site');expect(text).toContain('[Активности]');
 expect(entities.filter(e=>e.className==='MessageEntityTextUrl').length).toBe(5);
 expect(plain).toContain('🗓️ 29 октября');expect(plain).not.toContain('Выпуск от');expect(plain).not.toContain('Привет!');
 expect(plain).toContain('Коротко о главном — детали по ссылкам.');expect(text).toContain('[Подробнее →](https://example.com/announcement)');
 expect(plain).not.toContain('на сайте');
 expect(highlightedLead('**Факт** [обман](javascript:alert(1))')).not.toContain('[обман]');
});
test('caption fitting removes whole stories and cannot truncate a paragraph or footer',()=>{
 const stories=Array.from({length:4},(_,i)=>({...story(),title:story().title+' '+i}));
 const chosen=fitDailyStories('Главное за день','2026-10-29T08:00:00Z',stories,1000);
 expect(chosen.length).toBeGreaterThan(0);expect(chosen.length).toBeLessThan(4);
 const text=channelDailyText('Главное за день','2026-10-29T08:00:00Z',chosen);expect(text).toContain('**© Copyright');
 for(const a of chosen)expect(text).toContain(a.title);
 expect(()=>fitDailyStories('Главное за день','2026-10-29T08:00:00Z',stories,30)).toThrow();
});
test('fact checker requires two opened independent owners, not two company pages or claimed unopened corroboration',()=>{
 const a=story(),base={problems:[],sources_opened:a.items.map(x=>x.url),event_supported:true,event_evidence_url:a.items[0].url,all_claims_cross_checked:true,primary_source_official:true,
 independent_sources:a.items.map((x,i)=>({url:x.url,publisher:i?'Independent newsroom':'Official team',owner:i?'Independent media owner':'Project owner'}))};
 const c={...a,requireEvent:true,requireIndependentSources:true};
 expect(verdictFrom(base,[],c).problems).toEqual([]);
 for(const changed of [{primary_source_official:false},{primary_source_official:undefined},{all_claims_cross_checked:false},{independent_sources:base.independent_sources.map(x=>({...x,owner:'Same owner'}))},{independent_sources:undefined},{independent_sources:[...base.independent_sources,{...base.independent_sources[0],owner:'Conflicting owner'}]},{independent_sources:[base.independent_sources[0],{...base.independent_sources[1],owner:'!!!'}]},{sources_opened:[a.items[0].url]},{independent_sources:base.independent_sources.map(x=>({...x,url:'https://other.test'}))}])expect(verdictFrom({...base,...changed},[],c).problems.some(p=>p.severity==='block')).toBe(true);
 expect(verdictFrom({problems:[],sources_opened:a.items.map(x=>x.url)},[],{...a,requireEvent:false}).problems).toEqual([]);
});
test('the final checker JSON example includes every mandatory independence field',()=>{
 const prompt=factCheckPrompt({...story(),requireEvent:true,requireIndependentSources:true,eventWindow:{from:'2026-10-28',to:'2026-10-29'}});
 const schema=JSON.parse(prompt.split('\n').at(-1)!);
 expect(schema).toHaveProperty('independent_sources');expect(schema).toHaveProperty('all_claims_cross_checked');expect(schema).toHaveProperty('primary_source_official');expect(schema).toHaveProperty('event_date');
});
test('Telegram split bold entities compare by exact coverage; lost links or accents fail readback',()=>{
 const expected=[{className:'MessageEntityBold',offset:0,length:10},{className:'MessageEntityTextUrl',offset:5,length:5,url:'https://example.com'}];
 const split=[{className:'MessageEntityBold',offset:0,length:5},{className:'MessageEntityBold',offset:5,length:5},expected[1]];
 expect(sameChannelEntities(expected,split)).toBe(true);expect(sameChannelEntities(expected,split.slice(0,2))).toBe(false);
 expect(sameChannelEntities(expected,[{...split[0],length:4},...split.slice(1)])).toBe(false);
 expect(sameChannelEntities(expected,[{...expected[0],length:1e20}])).toBe(false);
});
