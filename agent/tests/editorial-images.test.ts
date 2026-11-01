import {test,expect} from 'bun:test';
import {readSourceImages,allowedSourceImage,validateResearchImages,IMAGE_LIMIT,IMAGE_TOTAL_LIMIT} from '../lib/editorial-images.ts';
import {factCheck} from '../lib/fact-check.ts';
const url='https://pbs.twimg.com/media/real.jpg?name=orig';
const jpg=Uint8Array.from([255,216,255,224,0,0]);
const record=(urls=[url])=>[{media:urls.map(url=>({url,type:'image'}))}];
test('only fixed HTTPS platform media hosts are downloaded, redirects cannot escape',async()=>{
 for(const bad of ['http://pbs.twimg.com/media/x','https://pbs.twimg.com.evil.test/media/x','https://127.0.0.1/media/x','https://pbs.twimg.com@evil.test/media/x','https://pbs.twimg.com:444/media/x','file:///etc/passwd','https://pbs.twimg.com/profile_images/x'])expect(allowedSourceImage(bad)).toBe(false);
 let calls=0;
 const images=await readSourceImages(record([url,url,'http://127.0.0.1/secret']),async(input,opts)=>{
  calls++;expect(input).toBe(url);expect(opts?.redirect).toBe('error');expect(opts?.signal).toBeDefined();
  return new Response(jpg,{headers:{'content-type':'image/jpeg'}});
 });
 expect(calls).toBe(1);expect(images).toHaveLength(1);validateResearchImages(images);
 expect(await readSourceImages(record(),async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}}))).toEqual([]);
});
test('MIME, signature and declared/chunked sizes are independently bounded',async()=>{
 for(const response of [new Response('<script>alert(1)</script>',{headers:{'content-type':'image/jpeg'}}),
  new Response(jpg,{headers:{'content-type':'text/html'}}),new Response(jpg,{headers:{'content-type':'image/jpeg','content-length':String(IMAGE_LIMIT+1)}})]) {
  expect(await readSourceImages(record(),async()=>response)).toEqual([]);
 }
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(IMAGE_LIMIT+1));},cancel(){cancelled=true;}});
 expect(await readSourceImages(record(),async()=>new Response(body,{headers:{'content-type':'image/jpeg'}}))).toEqual([]);
 expect(cancelled).toBe(true);
 expect(()=>validateResearchImages([{url,mediaType:'image/png',bytes:jpg}])).toThrow();
 expect(()=>validateResearchImages([{url:'https://evil.test/x',mediaType:'image/jpeg',bytes:jpg}])).toThrow();
});
test('failed images stay unavailable; requests and total bytes have batch limits',async()=>{
 let calls=0;
 const urls=Array.from({length:9},(_,i)=>`https://pbs.twimg.com/media/image${i}.jpg`);
 await readSourceImages(record(urls),async()=>{calls++;throw Error('unavailable')});expect(calls).toBe(4);
 const bytes=new Uint8Array(IMAGE_LIMIT);bytes.set(jpg);
 const images=await readSourceImages(record(urls),async()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}}));
 expect(images.reduce((n,i)=>n+i.bytes.byteLength,0)).toBe(IMAGE_TOTAL_LIMIT);expect(images).toHaveLength(3);
 calls=0;
 await readSourceImages(record(urls),async()=>{calls++;return new Response(new Uint8Array(IMAGE_LIMIT),{headers:{'content-type':'image/jpeg'}})});
 expect(calls).toBe(3); // Invalid signatures consume the download budget too.
 expect(()=>validateResearchImages(Array.from({length:5},()=>({url,mediaType:'image/jpeg',bytes:jpg})))).toThrow();
});
test('fact checker receives actual pixels, but downloading an image never automatically approves it',async()=>{
 const post='https://x.com/project/status/123456789';let attached=false;
 const v=await factCheck({title:'В тизере показали число 26',requireEvent:true,items:[{text:'post',url:post}]},{
  fetchImpl:(async(input)=>String(input).includes('api.fxtwitter.com')
   ?Response.json({tweet:{text:'New teaser',media:{photos:[{url}]}}})
   :String(input).startsWith('https://pbs.twimg.com/')?new Response(jpg,{headers:{'content-type':'image/jpeg'}}):new Response(null,{status:403})) as typeof fetch,
  ask:async(_prompt,options)=>{
   attached=options?.images?.[0].url===url;expect(options?.images?.[0].bytes).toEqual(Buffer.from(jpg));
   return JSON.stringify({problems:[],event_supported:true,event_evidence_url:post});
  },
 });
 expect(attached).toBe(true);expect(v.problems.some(p=>p.issue.includes('медиа')&&p.severity==='block')).toBe(true);
});
