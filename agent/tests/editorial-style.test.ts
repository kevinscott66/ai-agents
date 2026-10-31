import{test,expect}from'bun:test';
import{EDITORIAL_STYLE_GUIDE,editorialStyleFindings,editorialStyleErrors}from'../lib/editorial-style.ts';
import{EDITORIAL_SYSTEM,checkPublication,checkActivityPublication}from'../tools/site-editorial.ts';
import{researchArticles}from'../tools/daily-draft.ts';
import{checkEntry,checkActivity}from'../lib/site-editorial-state.ts';

const copy=()=>({title:'Платформа открыла регистрацию и опубликовала условия нового этапа тестирования',summary:'Команда открыла регистрацию на новый этап тестирования и опубликовала инструкцию для участников.',body:('Участнику нужно проверить доступность регистрации в своём аккаунте и прочитать опубликованные условия. ').repeat(4),intro:('Команда открыла регистрацию на новый этап и описала условия участия в официальной документации. ').repeat(4),items:[{text:'Источник',url:'https://example.com/news'}]});
const raw={id:'style',title:'Исходный заголовок материала',date:'2026-10-30',items:copy().items};
test('same substantive writing guide reaches site and daily model contexts',async()=>{
 expect(EDITORIAL_SYSTEM).toContain(EDITORIAL_STYLE_GUIDE);let system='';
 await expect(researchArticles([],{ask:async(s)=>{system=s;return'{"articles":[]}';}})).rejects.toThrow('No fresh');
 expect(system).toContain(EDITORIAL_STYLE_GUIDE);
});
test('assistant responses are blocked in each reader-facing field',()=>{
 for(const field of ['title','summary','body','intro'])expect(editorialStyleErrors({[field]:'Вот исправленный текст для публикации.'})).toContain(`${field}: в тексте остался ответ ассистента заказчику`);
});
test('unfilled editorial templates and internal citation tokens cannot pass as public copy',()=>{
 for(const body of ['[Вставьте название проекта]','{{project_name}}','Факт citeturn0search1','Факт contentReference[oaicite:0]','Проверка turn12view5'])expect(editorialStyleErrors({body}).length).toBeGreaterThan(0);
});
test('canned filler is rejected without a blanket ban on normal copulas',()=>{
 expect(editorialStyleErrors({body:'Стоит отметить, что это новый этап.'})).not.toEqual([]);
 expect(editorialStyleErrors({body:'Депозит является обеспечением займа. Продукт представляет собой кошелёк с ограничениями доступа.'})).toEqual([]);
});
test('quoted examples, blockquotes and code discussing generated text remain readable',()=>{
 for(const body of ['В ответе было написано «Вот исправленный текст».','В отчёте цитируется “As an AI language model”.','Пример: `turn0search1`.','```text\n[Вставьте название]\n```','> Не секрет, что это пример.\nКоманда исправила ответ.'])expect(editorialStyleErrors({body})).toEqual([]);
});
test('real URLs, code placeholders and emoji/dashes/bold alone are not evidence of a defect',()=>{
 expect(editorialStyleErrors({title:'🔥 Обновление — **подтверждено**',body:'Источник [релиз](https://example.com/turn0search1). Код: `array[index]`.'})).toEqual([]);
 expect(editorialStyleFindings({body:'**30 октября** проверили **два условия** — заявку и адрес.'})).toEqual([]);
});
test('vague attribution and empty significance warn without blocking or labelling authorship',()=>{
 const a={body:'Эксперты считают, что продукт меняет правила игры.'};
 expect(editorialStyleFindings(a).map(f=>f.code)).toEqual(['vague-attribution','empty-significance']);expect(editorialStyleErrors(a)).toEqual([]);
 expect(editorialStyleFindings({body:'Аналитики TRM Labs сообщили о переводе средств.'})).toEqual([]);
});
test('repeated lead and excessive bold have contextual warnings',()=>{
 const summary='Команда опубликовала условия регистрации и отдельно описала требования к аккаунтам участников нового тестирования.';
 expect(editorialStyleFindings({summary,body:summary+' Дополнительные сведения.'}).some(f=>f.code==='repeated-lead')).toBe(true);
 expect(editorialStyleFindings({body:'**Длинный первый фрагмент** **длинный второй фрагмент** **длинный третий фрагмент**'}).some(f=>f.code==='overemphasis')).toBe(true);
});
test('style checks never alter facts, dates, identifiers or original markup',()=>{
 const a={title:'Binance оценила последствия атаки в $6,3 млрд',summary:'**30 октября** заблокировали около **$3 млрд**.',body:'Эксперты считают, что это новый этап.'};const before=structuredClone(a);editorialStyleFindings(a);editorialStyleErrors(a);expect(a).toEqual(before);
});
test('digest and activity proposal gates reject publication residue',()=>{
 expect(checkEntry({...copy(),body:copy().body+' Вот готовый текст.'},raw).some(x=>x.includes('ассистента'))).toBe(true);
 expect(checkActivity({...copy(),intro:copy().intro+' [Укажите источник]'},raw).some(x=>x.includes('шаблон'))).toBe(true);
});
test('final manual-overlay copy is checked before costly factual verification',async()=>{
 let called=0;const verify=async()=>{called++;return[];};
 expect(await checkPublication(copy(),raw,{summary:'Вот готовый текст.'},verify)).toContain('summary: в тексте остался ответ ассистента заказчику');
 expect(await checkActivityPublication(copy(),raw,{intro:'[Укажите источник]'},verify)).toContain('intro: остался незаполненный шаблон');
 expect(called).toBe(0);
});
