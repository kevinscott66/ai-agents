import {resolve} from 'node:path';
/** Public code/assets only. Owner data remains behind paired /api/web auth. */
export async function officeStatic(url:URL,method:string,root=process.env.OFFICE_STATIC_DIR):Promise<Response|null>{
 if(url.pathname!=='/office'&&!url.pathname.startsWith('/office/'))return null;
 if(!['GET','HEAD'].includes(method))return new Response('Method not allowed',{status:405});
 if(!root||process.env.NATIVE_OFFICE_ENABLED!=='true')return new Response('Office unavailable',{status:503});
 if(url.pathname==='/office')return new Response(null,{status:308,headers:{Location:'/office/'}});
 const name=url.pathname.slice('/office/'.length)||'index.html';
 if(name!=='index.html'&&!/^(assets\/[a-zA-Z0-9_/-]+\.(js|css|glb|jpg|png|webp)|licenses\/[a-zA-Z0-9_-]+\.txt)$/.test(name))return new Response('Not found',{status:404});
 const file=Bun.file(resolve(root,name));if(!await file.exists())return new Response('Not found',{status:404});
 return new Response(method==='HEAD'?null:file,{headers:{'Content-Type':file.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Permissions-Policy':'microphone=(), camera=(), geolocation=()'}});
}
