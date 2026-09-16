import {expect,test} from 'bun:test';
import {watchMacHistory} from '../miniapp/src/lib/mac-refresh';
import {toMacSession} from '../miniapp/src/lib/mac-session';
test('real completion refreshes saved output with bounded coalescing and cleanup',async()=>{
 let callback:()=>void=()=>{}, calls=0, removed=false;
 let action:any={id:'run',status:'attempted',created_at:1,payload:{project:'/fixture'},result:{}};
 let session:any;
 const stop=watchMacHistory(async()=>{calls++;session=toMacSession(action);},(name,cb)=>{
  expect(name).toBe('action.executed');callback=()=>cb({});return()=>{removed=true;};
 },()=>true,20);
 await Bun.sleep(5);expect(session.status).toBe('running');
 action={...action,status:'ok',result:{output:'actual saved result'}};
 for(let i=0;i<30;i++)callback();
 await Bun.sleep(730);expect(session.status).toBe('completed');expect(session.output).toEqual(['actual saved result']);
 expect(calls).toBeLessThanOrEqual(2);
 stop();const before=calls;await Bun.sleep(730);expect(calls).toBe(before);expect(removed).toBe(true);
});
test('refreshes serialize and completion during fetch is not lost',async()=>{
 let callback:()=>void=()=>{}, release:()=>void=()=>{}, calls=0, concurrent=0,max=0;
 const stop=watchMacHistory(async()=>{calls++;concurrent++;max=Math.max(max,concurrent);if(calls===1)await new Promise<void>(r=>release=r);concurrent--;},(_name,cb)=>{callback=()=>cb({});return()=>{};},()=>true,10000);
 callback();await Bun.sleep(710);expect(calls).toBe(1);release();await Bun.sleep(710);
 expect(calls).toBe(2);expect(max).toBe(1);stop();
});
test('polling discovers new starts without any SSE producer and pauses while hidden',async()=>{
 let calls=0, visible=false;
 const stop=watchMacHistory(async()=>{calls++;},()=>()=>{},()=>visible,20);
 await Bun.sleep(40);expect(calls).toBe(0);visible=true;
 await Bun.sleep(730);expect(calls).toBe(1);stop();
});
