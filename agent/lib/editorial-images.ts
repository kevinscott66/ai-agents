/** Bounded source-image input, not a general URL or local-file reader. */
export type ResearchImage = {url: string; mediaType: 'image/jpeg'|'image/png'|'image/webp'; bytes: Uint8Array};
export const IMAGE_LIMIT = 4 * 1024 * 1024;
export const IMAGE_TOTAL_LIMIT = 12 * 1024 * 1024;
export const IMAGE_COUNT_LIMIT = 4;

export function allowedSourceImage(raw: string): boolean {
 try {
  const u=new URL(raw);
  return raw.length<=2048 && u.protocol==='https:' && u.hostname==='pbs.twimg.com' &&
   !u.username && !u.password && !u.port && !u.hash && /^\/(?:media|tweet_video_thumb)\//.test(u.pathname);
 } catch {return false;}
}

export function imageType(bytes: Uint8Array): ResearchImage['mediaType'] | null {
 const b=Buffer.from(bytes);
 if(b.length>=3 && b[0]===255 && b[1]===216 && b[2]===255)return 'image/jpeg';
 if(b.length>=8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(b.length>=12 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP')return 'image/webp';
 return null;
}

export function validateResearchImages(images: ResearchImage[]): void {
 let total=0;
 if(images.length>IMAGE_COUNT_LIMIT)throw new Error('Too many editorial images');
 for(const image of images) {
  total+=image.bytes.byteLength;
  if(!allowedSourceImage(image.url) || !image.bytes.byteLength || image.bytes.byteLength>IMAGE_LIMIT ||
   total>IMAGE_TOTAL_LIMIT || imageType(image.bytes)!==image.mediaType)throw new Error('Invalid editorial image');
 }
}

export async function readSourceImages(
 records: {media?: {url: string; type: string}[]}[],
 fetchImpl: (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response> = fetch,
): Promise<ResearchImage[]> {
 const images: ResearchImage[]=[];const seen=new Set<string>();let total=0,attempted=0;
 for(const record of records)for(const media of record.media??[]) {
  if(media.type!=='image' || !allowedSourceImage(media.url) || seen.has(media.url))continue;
  seen.add(media.url);
  if(attempted++>=IMAGE_COUNT_LIMIT || total>=IMAGE_TOTAL_LIMIT)return images;
  let reader: {cancel(): Promise<void>; releaseLock(): void}|undefined;
  try {
   const res=await fetchImpl(media.url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{accept:'image/jpeg,image/png,image/webp'}});
   const type=res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
   if(!res.ok || !res.body || !['image/jpeg','image/png','image/webp'].includes(type??'') ||
    Number(res.headers.get('content-length'))>Math.min(IMAGE_LIMIT,IMAGE_TOTAL_LIMIT-total)) {
    await res.body?.cancel();continue;
   }
   const active=res.body.getReader();reader=active;const chunks: Uint8Array[]=[];let size=0;
   while(true) {
    const next=await active.read();if(next.done)break;
    size+=next.value.byteLength;
    total+=next.value.byteLength;
    if(size>IMAGE_LIMIT || total>IMAGE_TOTAL_LIMIT)throw new Error('Editorial image too large');
    chunks.push(next.value);
   }
   const bytes=Buffer.concat(chunks);const mediaType=imageType(bytes);
   if(!mediaType || mediaType!==type)continue;
   images.push({url:media.url,mediaType,bytes});
  } catch { /* Remains an uninspected attachment; publication gates decide whether it is necessary. */ }
  finally {try {await reader?.cancel();}catch {}reader?.releaseLock();}
 }
 return images;
}
