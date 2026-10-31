import {expect, test} from 'bun:test';
import {editorialSourceUrl, cleanEditorialSources} from '../lib/editorial-sources.ts';
import {checkEntry, checkPublication, editorialPrompt, type EditorialEntry} from '../tools/site-editorial.ts';
import {factCheckPrompt} from '../lib/fact-check.ts';

const original='https://backpack.exchange/signup?referral=private-code&utm_source=channel';
const clean='https://backpack.exchange/signup';
const raw={id:'story',title:'Backpack: Программа',items:[{text:'Условия',url:original}]};
const entry:EditorialEntry={
 title:'Backpack открыл новую неделю программы Mystery Boxes',
 summary:'Участники программы могут изучить официальные условия. Торговые задания требуют регистрации и проверки допуска.',
 body:'В программе предусмотрены торговые задания. Условия допуска, сроки и риски опубликованы организатором. '.repeat(5),
 items:[{text:'Условия программы',url:clean}],
};

test('cleaning a referral does not make the original source disappear or preserve hidden incentives',()=>{
 expect(editorialSourceUrl(original)).toBe(clean);
 expect(checkEntry(entry,raw)).toEqual([]);
 expect(checkEntry({...entry,items:raw.items},raw).join()).toContain('реферальные');
 const prompt=editorialPrompt(raw,[]);
 expect(prompt).toContain(clean);
 expect(prompt).not.toContain('private-code');
 expect(prompt).not.toContain('ВСЕ ссылки поста обязаны остаться');
});

test('source identity is preserved: a different page, record ID or functional parameter cannot substitute for the original',()=>{
 for(const url of ['https://backpack.exchange/', 'https://evil.example/signup']) {
  expect(checkEntry({...entry,items:[{text:'Source',url}]},raw).join()).toContain('потеряны');
 }
 for(const url of ['https://example.com/post?id=42&code=access#details','https://x.com/Project/status/123?s=20',
  'https://tally.so/r/invitation','https://discord.gg/invite','https://example.com/ref/campaign']) {
  expect(editorialSourceUrl(url)).toBe(url);
 }
 const record={...raw,items:[{text:'Source',url:'https://example.com/post?id=42&ref=a'}]};
 expect(checkEntry({...entry,items:[{text:'Source',url:'https://example.com/post?id=43'}]},record).join()).toContain('потеряны');
});

test('normalization is bounded to HTTP(S) query attribution; malformed and dangerous protocols remain invalid',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,test','not a url']) expect(editorialSourceUrl(url)).toBe(url);
 expect(editorialSourceUrl('https://example.com/page?REF=a&ref=b&referral_code=c&invite_code=d&keep=2#part'))
  .toBe('https://example.com/page?keep=2#part');
 const input=[{text:'Source',url:original}];
 expect(cleanEditorialSources(input)).toEqual([{text:'Source',url:clean}]);
 expect(input[0].url).toBe(original);
});

test('final verifier receives the same cleaned manual source page as the website without altering the human journal',async()=>{
 const manual={items:[{text:'Ручная ссылка',url:original}]};
 let seen=false;
 const errors=await checkPublication(entry,raw,manual,async merged=>{
  seen=true;expect(merged.items).toEqual([{text:'Ручная ссылка',url:clean}]);return [];
 });
 expect(seen).toBe(true);expect(errors).toEqual([]);expect(manual.items[0].url).toBe(original);
});

test('cleaning does not allow dropping an inaccessible original source',()=>{
 const row={...raw,items:[{text:'Old source',url:'https://example.com/dead-story'}]};
 expect(checkEntry(entry,row).join()).toContain('https://example.com/dead-story');
});

test('checker guidance requires independent account attribution and distinguishes estimates from promises',()=>{
 const prompt=factCheckPrompt({title:'Project announcement'},[{url:'https://x.com/Project/status/123',text:'Project announced a testnet'}]);
 expect(prompt).toContain('официальный сайт или документацию');
 expect(prompt).toContain('совпадает по автору и ID поста');
 expect(prompt).toContain('Укажи обе ссылки в sources_opened');
 expect(prompt).toContain('Одно совпадение имени, логотипа или галочка');
 expect(prompt).toContain('не требуй официальной публикации этой оценки');
 expect(prompt).toContain('для них по-прежнему нужны подтверждённые условия');
 expect(prompt).toContain('с конкретным утверждением или действием читателя');
 expect(prompt).toContain('не обещает фиксированную выплату');
 expect(prompt).toContain('Для архивной новости проверяй заявленные тогда условия');
 expect(prompt).toContain('Существенные ограничения допуска, обязательный депозит, KYC');
});
