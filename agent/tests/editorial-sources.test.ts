import {expect, test} from 'bun:test';
import {editorialSourceUrl, cleanEditorialSources, preserveEditorialSources} from '../lib/editorial-sources.ts';
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

test('Entropy referral r can be removed without losing the source; other functional r parameters remain',()=>{
 const row={...raw,items:[{text:'Referrals',url:'https://entropy.io/?r=entropyregister'}]};
 expect(editorialSourceUrl(row.items[0].url)).toBe('https://entropy.io/');
 expect(checkEntry({...entry,items:[{text:'Условия',url:'https://entropy.io/'}]},row)).toEqual([]);
 for(const url of ['https://example.com/?r=report','https://entropy.io/docs?r=section',
   'https://entropy.io.evil.example/?r=code','https://sub.entropy.io/?r=code']) {
  expect(editorialSourceUrl(url)).toBe(url);
 }
});

test('writer may omit X share tracking while published sources retain the original post address',()=>{
 const original='https://x.com/nadoHQ/status/2115828381329580065?s=20';
 const proposed=[{text:'Официальный анонс',url:'https://x.com/nadoHQ/status/2115828381329580065'}];
 const required=[{text:'PRIME',url:original}];
 const final=preserveEditorialSources(proposed,required);
 expect(final).toEqual([{text:'Официальный анонс',url:original}]);
 expect(checkEntry({...entry,items:final},{...raw,items:required})).toEqual([]);
 expect(proposed[0].url).not.toBe(original);
 expect(required[0].url).toBe(original);
 expect(preserveEditorialSources([{text:'Share',url:original+'&t=share'}],required)[0].url).toBe(original);
});

test('Backpack and Human canonical post links retain their original a/s share addresses and still need factual approval',async()=>{
 for(const original of [
  'https://x.com/Backpack/status/2116832290575876141?a=FcRcuw47Dvqm90rdjDE&s=20',
  'https://x.com/humntech/status/2108580066552951000?a=oTRwttHhIkS9GMThTLE&s=09',
 ]) {
  const required=[{text:'Анонс',url:original}];
  const proposed=[{text:'Официальный анонс',url:original.split('?')[0]}];
  const items=preserveEditorialSources(proposed,required);
  expect(items).toEqual([{text:'Официальный анонс',url:original}]);
  expect(checkEntry({...entry,items},{...raw,items:required})).toEqual([]);
  expect(proposed[0].url).toBe(original.split('?')[0]);
  expect(required[0].url).toBe(original);
  let verified=false;
  const errors=await checkPublication({...entry,items},{...raw,items:required},{},async published=>{
   verified=true;expect(published.items).toEqual(items);
   return ['официальный источник не подтверждает обещанную награду'];
  });
  expect(verified).toBe(true);
  expect(errors).toEqual(['официальный источник не подтверждает обещанную награду']);
 }
});

test('a share reconciliation cannot restore an omitted source or change its author, status, destination or functional parameters',()=>{
 const original='https://x.com/Backpack/status/2116832290575876141?a=share&s=20&id=42&code=access#terms';
 const required=[{text:'Анонс',url:original}];
 const canonical='https://x.com/Backpack/status/2116832290575876141?id=42&code=access#terms';
 expect(preserveEditorialSources([{text:'Анонс',url:canonical}],required)[0].url).toBe(original);
 const missing=preserveEditorialSources([],required);
 expect(missing).toEqual([]);
 expect(checkEntry({...entry,items:missing},{...raw,items:required}).join()).toContain('потеряны');
 for(const url of [
  canonical.replace('Backpack','Other'),canonical.replace('Backpack','backpack'),
  canonical.replace('2116832290575876141','2116832290575876142'),
  canonical.replace('x.com','twitter.com'),canonical.replace('x.com','x.com.evil.example'),
  canonical.replace('id=42','id=43'),canonical.replace('&code=access',''),
  canonical.replace('#terms','#other'),canonical.replace('https:','http:'),
  canonical.replace('x.com','user@x.com'),canonical.replace('x.com','x.com:444'),
 ]) {
  const items=preserveEditorialSources([{text:'Изменённый источник',url}],required);
  expect(items[0].url).toBe(url);
  expect(checkEntry({...entry,items},{...raw,items:required}).join()).toContain('потеряны');
 }
});

test('a remains functional outside the existing exact HTTPS x.com status boundary',()=>{
 for(const original of [
  'https://example.com/Backpack/status/2116832290575876141?a=report',
  'https://twitter.com/Backpack/status/2116832290575876141?a=report',
  'https://x.com/Backpack?a=report','https://x.com/i/article/2116832290575876141?a=report',
  'https://x.com/Backpack/status/2116832290575876141/photo/1?a=report',
  'https://x.com/Backpack/status/2116832290575876141?A=report',
 ]) {
  const url=original.split('?')[0],required=[{text:'Источник',url:original}];
  expect(editorialSourceUrl(original)).toBe(original);
  const items=preserveEditorialSources([{text:'Источник',url}],required);
  expect(items[0].url).toBe(url);
  expect(checkEntry({...entry,items},{...raw,items:required}).join()).toContain('потеряны');
 }
});

test('source reconciliation cannot invent a missing URL or substitute a page, author, post or functional query',()=>{
 const source={text:'Post',url:'https://x.com/nadoHQ/status/123?s=20&id=42'};
 for(const url of ['https://x.com/nadoHQ/status/124?id=42','https://x.com/Other/status/123?id=42',
  'https://x.com/nadoHQ/status/123?id=43','https://x.com/nadoHQ/status/123',
  'https://x.com.evil.example/nadoHQ/status/123?id=42','https://twitter.com/nadoHQ/status/123?id=42']) {
  expect(preserveEditorialSources([{text:'Changed',url}],[source])[0].url).toBe(url);
 }
 expect(preserveEditorialSources([], [source])).toEqual([]);
 for(const [url,original] of [['https://waitlist.arcus.xyz/','https://waitlist.arcus.xyz/s'],
   ['https://squeekchain.com/genesis','https://squeekchain.com/genesis/i/z9w4ngyr']]) {
  const required=[{text:'Required',url:original}];
  expect(preserveEditorialSources([{text:'Different',url}],required)[0].url).toBe(url);
  expect(checkEntry({...entry,items:[{text:'Different',url}]},{...raw,items:required}).join()).toContain('потеряны');
 }
});


test('reconciled share links and added sources still reach final factual verification',async()=>{
 const required=[{text:'PRIME',url:'https://x.com/nadoHQ/status/2115828381329580065?s=20'}];
 const items=preserveEditorialSources([{text:'Анонс',url:'https://x.com/nadoHQ/status/2115828381329580065'},
  {text:'Официальные условия',url:'https://app.nado.xyz/?ref=abc'}],required);
 let checked=false;
 const errors=await checkPublication({...entry,items},{...raw,items:required},{},async published=>{
  checked=true;
  expect(published.items).toEqual([{text:'Анонс',url:required[0].url},{text:'Официальные условия',url:'https://app.nado.xyz/'}]);
  return ['источники не подтверждают условие участия'];
 });
 expect(checked).toBe(true);
 expect(errors).toEqual(['источники не подтверждают условие участия']);
});
