/** Daily-channel contract, separate from article and legacy weekly formats. */
import {plainInline,itemEmoji,ruDate,primarySourceLink} from './delabs-text.ts';
import {CHANNEL_FOOTER} from './channel-footer.ts';
import {plainTelegramLength} from './telegram-format.ts';
export const CHANNEL_SPEC_VERSION=1;
export const CHANNEL_MAX_PLAIN=1900;
export interface DailyStory {title:string;date:string;summary:string;body:string;items:{text:string;url:string}[];emoji?:string;}
const accents=(s:string)=>[...s.matchAll(/\*\*([^*\n]+)\*\*/g)];
export function dailyStoryErrors(a:DailyStory):string[]{
 const bad:string[]=[];const lead=plainInline(a.summary).trim();
 if(a.title.length<70||a.title.length>130)bad.push('ТЗ: заголовок должен содержать70–130знаков');
 if(lead.length<180||lead.length>340)bad.push('ТЗ: описание пункта должно содержать180–340знаков');
 if(a.body.length<600||a.body.length>1200||a.body.trim().split(/\n\s*\n/).length<2||a.body.trim().split(/\n\s*\n/).length>3)bad.push('ТЗ: полный материал600–1200знаков,2–3абзаца');
 if(/https?:\/\/|(?:javascript|data|vbscript):|<[^>]*>|\[[^\]]+\]\(/iu.test(a.title+' '+a.summary))bad.push('ТЗ: ссылки добавляются из проверенных источников, HTML запрещён');
 const highlighted=accents(a.summary);
 if(highlighted.length<1||highlighted.length>2||highlighted.some(m=>m[1].length>120)||highlighted.reduce((n,m)=>n+m[1].length,0)>lead.length/2)bad.push('ТЗ:1–2коротких жирных акцента внутри описания');
 if(a.summary.replace(/\*\*[^*\n]+\*\*/g,'').includes('*'))bad.push('ТЗ: некорректная жирная разметка описания');
 if(a.items.length<2||a.items.length>4||new Set(a.items.map(x=>x.url)).size!==a.items.length||a.items.some(x=>!primarySourceLink([x])))bad.push('ТЗ:2–4различных безопасных источника, первым официальный');
 if(/является|представляет собой|играет важную роль|(?:важно|необходимо|стоит) отметить|в современном мире|в эпоху цифровизации|не секрет, что|динамично развивается|откройте для себя|в заключение/iu.test([a.title,a.summary,a.body].join('\n')))bad.push('ТЗ: запрещённое ИИ-клише');
 return bad;
}
/** Keep only audited bold spans; injected links and block/HTML markup remain text. */
export function highlightedLead(raw:string):string {
 let last=0;const out:string[]=[];
 for(const m of accents(raw)) {
  out.push(plainInline(raw.slice(last,m.index)));out.push('**'+plainInline(m[1])+'**');last=m.index!+m[0].length;
 }
 out.push(plainInline(raw.slice(last)));return out.join('').replace(/[\r\n]+/g,' ');
}
export function channelDailyText(title:string,createdAt:string,articles:DailyStory[]):string {
 if(!articles.length||articles.length>4)throw Error('ТЗ: выпуск должен содержать1–4подтверждённых события');
 const errors=articles.flatMap(dailyStoryErrors);if(errors.length)throw Error(errors.join('; '));
 const lines=[`📰 **${plainInline(title)}**`,`🗓️ Выпуск от ${ruDate(new Date(createdAt))}`,'','Привет! Главное в крипте и AI.',''];
 articles.forEach((a,i)=>{
  const first=primarySourceLink(a.items).replace('[Первоисточник]','[Анонс]');
  const second=primarySourceLink(a.items.slice(1)).replace('[Первоисточник]','[Второй источник]');
  lines.push(`${i+1}. ${itemEmoji(a.emoji)} **${plainInline(a.title)}**`,`${highlightedLead(a.summary)} ${first} · ${second}`,'');
 });
 lines.push(CHANNEL_FOOTER);return lines.join('\n');
}
/** Drop only complete stories; never cut a title, paragraph or footer to fit. */
export function fitDailyStories<T extends DailyStory>(title:string,createdAt:string,articles:T[],limit=CHANNEL_MAX_PLAIN):T[]{
 const selected=articles.slice(0,4);
 while(selected.length&&plainTelegramLength(channelDailyText(title,createdAt,selected))>Math.min(limit,CHANNEL_MAX_PLAIN))selected.pop();
 if(!selected.length)throw Error('ТЗ: ни один полный пункт не помещается в подпись');
 return selected;
}
/** Telegram may split one bold entity at a link boundary; compare coverage. */
export function sameChannelEntities(expected:any[],actual:any[]):boolean {
 for(const type of ['MessageEntityBold','MessageEntityTextUrl','MessageEntityCustomEmoji']) {
  if([...expected,...actual].some(e=>!Number.isInteger(e.offset)||!Number.isInteger(e.length)||e.offset<0||e.length<1||e.offset+e.length>4096))return false;
  const rows=(xs:any[])=>xs.filter(x=>x.className===type);
  if(type==='MessageEntityBold') {
   const coverage=(xs:any[])=>new Set(rows(xs).flatMap(e=>Array.from({length:e.length},(_,i)=>e.offset+i)));
   const a=coverage(expected),b=coverage(actual);if(a.size!==b.size||[...a].some(i=>!b.has(i)))return false;
  }else{
   const keys=(xs:any[])=>rows(xs).map(e=>`${e.offset}:${e.length}:${e.url??e.documentId??''}`).sort();
   if(JSON.stringify(keys(expected))!==JSON.stringify(keys(actual)))return false;
  }
 }
 return true;
}
