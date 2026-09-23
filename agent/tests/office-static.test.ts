import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {officeStatic} from '../lib/office-static';
test('office static assets are gated, path-allowlisted and carry a same-origin CSP',async()=>{
 const previous=process.env.NATIVE_OFFICE_ENABLED,root=mkdtempSync(join(tmpdir(),'office-static-'));
 try{mkdirSync(join(root,'assets'));writeFileSync(join(root,'index.html'),'office');writeFileSync(join(root,'assets/app.js'),'export{}');writeFileSync(join(root,'secret.txt'),'CANARY');
 process.env.NATIVE_OFFICE_ENABLED='false';expect((await officeStatic(new URL('https://host/office/'),'GET',root))?.status).toBe(503);
 process.env.NATIVE_OFFICE_ENABLED='true';const page=await officeStatic(new URL('https://host/office/'),'GET',root);expect(await page?.text()).toBe('office');expect(page?.headers.get('content-security-policy')).toContain("connect-src 'self' blob:;");
 for(const path of ['secret.txt','assets/../secret.txt','assets/%2e%2e%2fsecret.txt','assets/app.js.map','assets/.env'])expect((await officeStatic(new URL('https://host/office/'+path),'GET',root))?.status).toBe(404);
 expect((await officeStatic(new URL('https://host/office/'),'POST',root))?.status).toBe(405);expect(await officeStatic(new URL('https://host/chat/'),'GET',root)).toBeNull();
 }finally{rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.NATIVE_OFFICE_ENABLED;else process.env.NATIVE_OFFICE_ENABLED=previous;}
});
