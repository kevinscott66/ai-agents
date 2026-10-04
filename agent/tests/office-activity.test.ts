import { test, expect } from 'bun:test';
import { observeOfficeActivity, officeActivityCount } from '../lib/office-activity';
test('owner activity isolates identities and counts concurrent delegates until their own finally', async () => {
 let release!:()=>void;
 const gate=new Promise<void>(r=>release=r);
 const one=observeOfficeActivity('owner','qa',()=>gate);
 const two=observeOfficeActivity('owner','qa',()=>gate);
 expect(officeActivityCount('owner','qa')).toBe(2);
 expect(officeActivityCount('other','qa')).toBe(0);
 await expect(observeOfficeActivity('owner','qa',async()=>{throw Error('failure');})).rejects.toThrow('failure');
 expect(officeActivityCount('owner','qa')).toBe(2);
 await observeOfficeActivity(undefined,'qa',async()=>expect(officeActivityCount('other','qa')).toBe(0));
 release();await Promise.all([one,two]);expect(officeActivityCount('owner','qa')).toBe(0);
});
