/** Bounded comparison context, never an automatic semantic merge or project blacklist. */
export interface PriorPublication {id:string;title:string;summary?:string;date?:string;}
const words=(text:string)=>new Set([...(text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g)??[]),...(text.match(/[А-ЯЁ][а-яё]{2,}/gu)??[]).map(w=>w.toLowerCase())]
 .filter(w=>!['mainnet','testnet','beta','nft','the','token','airdrop','discord','twitter','команда','компания','проект','биржа','запуск','после','программа','новый'].includes(w)));
export function relatedPublications(title:string,rows:readonly PriorPublication[],excludeId?:string):PriorPublication[]{
 const names=words(title);
 return rows.filter(row=>row.id!==excludeId&&typeof row.title==='string'&&[...words(row.title)].some(w=>names.has(w)))
 .sort((a,b)=>String(b.date??'').localeCompare(String(a.date??''))).slice(0,12)
 .map(row=>({id:row.id.slice(0,250),title:row.title.slice(0,200),summary:String(row.summary??'').slice(0,500),date:row.date}));
}
