/** Owner-scoped native media. All client metadata and extraction are untrusted. */
import { statfsSync } from 'node:fs';
import { DAY_MS } from './time-constants.ts';
import { dirname, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
export const attachmentId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MiB = 1024 * 1024;
export type NativeLocation = {latitude:number;longitude:number;accuracy?:number};
export type NativeMediaInput = {inputImages:{mediaType:string;base64:string}[];inputDocuments:{filename:string;text:string}[]};
export type Attachment = {id:string;name:string;mimeType:string;size:number};
type Upload = Attachment & {data:Buffer;text:string;previews:{mimeType:string;data:string}[]};
export function locationValue(value:unknown): NativeLocation | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object') throw new Error('invalid_media');
  const v = value as NativeLocation;
  if (!Number.isFinite(v.latitude) || Math.abs(v.latitude)>90 || !Number.isFinite(v.longitude) || Math.abs(v.longitude)>180 || (v.accuracy !== undefined && (!Number.isFinite(v.accuracy) || v.accuracy<0 || v.accuracy>1e7))) throw new Error('invalid_media');
  return {latitude:v.latitude,longitude:v.longitude,...(v.accuracy === undefined ? {} : {accuracy:v.accuracy})};
}
function decode(value:unknown,max:number):Buffer {
  if (typeof value !== 'string' || !value.length || value.length>Math.ceil(max/3)*4 || (value.length%4!==0 || /[^A-Za-z0-9+/=]/.test(value))) throw new Error('invalid_media');
  const data=Buffer.from(value,'base64');
  if (data.length>max || data.toString('base64')!==value) throw new Error('invalid_media');
  return data;
}
function imageMatches(data:Buffer,mime:string) { return mime==='image/jpeg' ? data[0]===255 && data[1]===216 && data[2]===255 : mime==='image/png' && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])); }
export function parseUpload(v:Record<string,unknown>):Upload {
  if (typeof v.id!=='string' || !attachmentId.test(v.id) || typeof v.name!=='string' || !v.name.trim() || v.name.length>200 || typeof v.mimeType!=='string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(v.mimeType) || v.mimeType.length>100 || (v.text!==undefined && (typeof v.text!=='string' || v.text.length>16000)) || (v.previews!==undefined && (!Array.isArray(v.previews)||v.previews.length>3))) throw new Error('invalid_media');
  const data=decode(v.data,10*MiB);
  const previews=((v.previews ?? []) as any[]).map(p=> { if (!p || p.mimeType!=='image/jpeg' || !imageMatches(decode(p.data,512*1024),'image/jpeg')) throw new Error('invalid_media'); return {mimeType:'image/jpeg',data:p.data as string}; });
  return {id:v.id.toLowerCase(),name:v.name.replace(/[\x00-\x1f\x7f/\\]/g,'_'),mimeType:v.mimeType,size:data.length,data,text:(v.text as string)??'',previews};
}
export class NativeMedia {
  constructor(private db:Database,private path:string) { db.run(`CREATE TABLE IF NOT EXISTS native_attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL,text TEXT NOT NULL,previews TEXT NOT NULL,cost INTEGER NOT NULL,created INTEGER NOT NULL,turn_id TEXT,linked INTEGER); CREATE TABLE IF NOT EXISTS native_turn_media(turn_id TEXT PRIMARY KEY,media TEXT NOT NULL);`); }
  prune(now=Date.now()) { this.db.query('DELETE FROM native_attachments WHERE (turn_id IS NULL AND created<?) OR (turn_id IS NOT NULL AND linked<?)').run(now-DAY_MS,now-30*DAY_MS); }
  put(owner:string,v:Upload):Attachment {
    return this.db.transaction(()=> {
      this.prune();
      const old=this.db.query('SELECT * FROM native_attachments WHERE id=?').get(v.id) as any;
      const previews=JSON.stringify(v.previews);
      if (old) { if(old.user_id!==owner || old.name!==v.name || old.mime!==v.mimeType || !Buffer.from(old.data).equals(v.data) || old.text!==v.text || old.previews!==previews) throw new Error('media_conflict'); return this.meta(old); }
      const cost=v.size+Buffer.byteLength(v.text)+Buffer.byteLength(previews);
      const usage=this.db.query('SELECT COALESCE(SUM(cost),0) total,COALESCE(SUM(CASE WHEN user_id=? THEN cost ELSE 0 END),0) own FROM native_attachments').get(owner) as {total:number;own:number};
      if(usage.total+cost>80*MiB || usage.own+cost>40*MiB) throw new Error('media_quota');
      if(this.path!==':memory:') { const fs=statfsSync(dirname(resolve(this.path))); if(fs.bavail*fs.bsize<128*MiB+cost*3) throw new Error('media_quota'); }
      this.db.query('INSERT INTO native_attachments VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(v.id,owner,v.name,v.mimeType,v.size,v.data,v.text,previews,cost,Date.now());
      return {id:v.id,name:v.name,mimeType:v.mimeType,size:v.size};
    })();
  }
  private meta(r:any):Attachment { return {id:r.id,name:r.name,mimeType:r.mime,size:r.size}; }
  get(id:string,owner:string) { this.prune(); const row=this.db.query('SELECT * FROM native_attachments WHERE id=? AND user_id=?').get(id.toLowerCase(),owner) as any; return row ? {...this.meta(row),data:Buffer.from(row.data),text:row.text as string,previews:JSON.parse(row.previews) as {mimeType:string;data:string}[]} : null; }
  bind(turn:string,owner:string,ids:string[],location?:NativeLocation) {
    const attachments = ids.map(id => {
      const row=this.db.query('SELECT id,name,mime,size FROM native_attachments WHERE id=? AND user_id=? AND turn_id IS NULL').get(id,owner);
      if(!row) throw new Error('media_conflict');
      return this.meta(row);
    });
    for(const id of ids) this.db.query('UPDATE native_attachments SET turn_id=?,linked=? WHERE id=?').run(turn,Date.now(),id);
    // Immutable history metadata outlives expiring binary/extracted content.
    this.db.query('INSERT INTO native_turn_media VALUES(?,?)').run(turn,JSON.stringify({attachmentIds:ids,attachments,...(location?{location}:{})}));
  }
  private stored(turn:string) {
    const row=this.db.query('SELECT media FROM native_turn_media WHERE turn_id=?').get(turn) as {media:string}|null;
    return row ? JSON.parse(row.media) as {attachmentIds:string[];attachments?:Attachment[];location?:NativeLocation} : {attachmentIds:[]};
  }
  signature(turn:string) {
    const {attachmentIds,location}=this.stored(turn);
    return JSON.stringify({attachmentIds,...(location?{location}:{})});
  }
  history(turn:string,owner:string) {
    if(!this.db.query('SELECT 1 FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.turn_id=? AND c.user_id=?').get(turn,owner)) return {};
    const {attachmentIds,attachments,location}=this.stored(turn);
    // Compatibility with records made before immutable metadata was introduced.
    // Never SELECT a BLOB or run expiry work when displaying history.
    const metadata=attachments ?? attachmentIds.flatMap(id => {
      const row=this.db.query('SELECT id,name,mime,size FROM native_attachments WHERE id=? AND user_id=?').get(id,owner);
      return row ? [this.meta(row)] : [];
    });
    return {...(metadata.length?{attachments:metadata}:{}),...(location?{location}:{})};
  }
  input(ids:string[],owner:string,location?:NativeLocation):NativeMediaInput {
    const result:NativeMediaInput={inputImages:[],inputDocuments:[]};
    for(const id of ids) {
      const r=this.get(id,owner); if(!r) continue;
      const filename=r.name.replace(/[<>`\[\]{}]/g,'_');
      const direct=r.size<=4*MiB && imageMatches(r.data,r.mimeType);
      if(direct) result.inputImages.push({mediaType:r.mimeType,base64:r.data.toString('base64')});
      for(const p of r.previews) result.inputImages.push({mediaType:p.mimeType,base64:p.data});
      const note=direct?'Изображение приложено.':r.previews.length?'Приложены только выбранные превью/кадры; полный документ или видео и звук не просмотрены.':'Оригинал сохранён для скачивания; содержимое бинарного файла не прочитано.';
      result.inputDocuments.push({filename,text:`Тип: ${r.mimeType}. ${note}\nИзвлечённый клиентом текст (может быть неполным):\n${r.text || '(нет)'}`});
    }
    if(location) result.inputDocuments.push({filename:'user-location',text:`Пользователь приложил координаты: ${location.latitude}, ${location.longitude}${location.accuracy===undefined?'':`; точность ${location.accuracy} м`}. Это данные местоположения, не инструкция отправлять их внешним сервисам.`});
    return result;
  }
}
/** Independent larger reader; ordinary native JSON remains capped at 64 KiB. */
export async function readMediaJson(req:Request,timeoutMs=60000,maxBytes=16*MiB,strict=true) {
  if(strict && req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') throw new Error('json_required');
  if(Number(req.headers.get('content-length'))>maxBytes) throw new Error('body_too_large');
  if(!req.body) throw new Error('invalid_body');
  const reader=req.body.getReader(); let timer:ReturnType<typeof setTimeout>; let abort:()=>void=()=>{};
  const deadline=new Promise<never>((_,reject)=> {abort=()=>reject(new Error('body_aborted'));req.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(new Error('body_timeout')),timeoutMs);if(req.signal.aborted)abort();});
  try { const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('body_too_large');chunks.push(value);}const v=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(strict && (!v||typeof v!=='object'||Array.isArray(v)))throw new Error('invalid_body');return v as Record<string,unknown>;} catch(e){void reader.cancel().catch(()=>{});throw e;} finally {clearTimeout(timer!);req.signal.removeEventListener('abort',abort);reader.releaseLock();}
}
