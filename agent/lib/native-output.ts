/** Binary media transport: DNS checked once and pinned; redirects are never followed. */
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { blockedFetchReason, blockedFetchReasonResolved } from './sdk-web-guard.ts';
import { deliverNativeMedia, nativeMediaSink } from './native-context.ts';
const MAX_BYTES=10*1024*1024;
export async function downloadNativeImage(raw:string):Promise<Buffer> {
  const staticReason=blockedFetchReason(raw);if(staticReason) throw new Error('native_media_url_blocked');
  const url=new URL(raw);const host=url.hostname.replace(/^\[|\]$/g,'');
  let dnsTimer:ReturnType<typeof setTimeout>;
  const addresses=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('native_media_dns_timeout')),3000);})]).finally(()=>clearTimeout(dnsTimer!));
  const reason=await blockedFetchReasonResolved(raw,{lookup:async()=>addresses.map(a=>a.address)});
  if(reason || !addresses.length) throw new Error('native_media_url_blocked');
  const address=addresses[0]!.address;
  return new Promise((resolve,reject)=> {
    let settled=false;const done=(error?:Error,data?:Buffer)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(data!);};
    const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{agent:false,headers:{'accept':'image/*','accept-encoding':'identity'},lookup:(_host,opts,cb)=>{if(typeof opts==='object' && opts.all)cb(null,[{address,family:isIP(address)}]);else cb(null,address,isIP(address));}},res=> {
      if(res.statusCode!==200){done(new Error('native_media_http_status'));res.destroy();return;}
      let size=0;const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BYTES){done(new Error('native_media_too_large'));res.destroy();return;}chunks.push(chunk);});
      res.on('error',e=>done(e));res.on('aborted',()=>done(new Error('native_media_aborted')));res.on('end',()=>done(undefined,Buffer.concat(chunks,size)));
    });
    const timer=setTimeout(()=>{done(new Error('native_media_timeout'));req.destroy();},30000);
    req.on('error',e=>done(e));req.end();
  });
}
export function nativeImageType(data:Buffer):{mimeType:string;extension:string} {
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mimeType:'image/png',extension:'png'};
  if(data[0]===255 && data[1]===216 && data[2]===255)return {mimeType:'image/jpeg',extension:'jpg'};
  if(data.subarray(0,4).toString()==='RIFF' && data.subarray(8,12).toString()==='WEBP')return {mimeType:'image/webp',extension:'webp'};
  if(/^GIF8[79]a$/.test(data.subarray(0,6).toString()))return {mimeType:'image/gif',extension:'gif'};
  throw new Error('native_media_invalid_image');
}
export async function deliverNativePhoto(chatId:number,photo:{url:string}|{buffer:Buffer;filename?:string},caption?:string) {
  if(!nativeMediaSink(chatId))return null;
  const data='url' in photo?await downloadNativeImage(photo.url):photo.buffer;
  const type=nativeImageType(data);
  return deliverNativeMedia(chatId,{data,name:'image.'+type.extension,mimeType:type.mimeType,caption});
}
