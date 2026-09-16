import {test,expect} from 'bun:test';
import {startTaskRefresh} from '../miniapp/src/lib/task-refresh.ts';
test('task refresh reconciles foreground and interval, skips overlap/hidden, cleans up',async()=>{
 let visible=true,listener=()=>{},tick=()=>{},calls=0,disposed=0,release!:()=>void;
 const stop=startTaskRefresh(async()=>{calls++;await new Promise<void>(r=>release=r);},{visible:()=>visible,subscribe:f=>{listener=f;return()=>disposed++;},interval:f=>{tick=f;return()=>disposed++;}});
 tick();listener();expect(calls).toBe(1);release();await Promise.resolve();await Promise.resolve();
 visible=false;tick();expect(calls).toBe(1);visible=true;listener();expect(calls).toBe(2);
 stop();release();await Promise.resolve();await Promise.resolve();tick();listener();expect(calls).toBe(2);expect(disposed).toBe(2);
});
test('failed refresh does not strand future reconciliation',async()=>{
 let tick=()=>{},calls=0;const stop=startTaskRefresh(async()=>{calls++;throw new Error('offline');},{visible:()=>true,subscribe:()=>()=>{},interval:f=>{tick=f;return()=>{};}});
 tick();await Promise.resolve();await Promise.resolve();tick();await Promise.resolve();expect(calls).toBe(2);stop();
});

test('missing selected detail never freezes a successfully refreshed board',async()=>{
 const source=await Bun.file(new URL('../miniapp/src/pages/Tasks.tsx',import.meta.url)).text();
 const start=source.indexOf('  async function load()');
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,source.indexOf('\n  useEffect(',start)));
 let board:unknown, error:unknown, loading=true;
 const load=new Function('api','beginLoad','setLoading','setErr','status','assignee','selectedId','setTasks','setTruncated','setSelectedSnapshot','formatApiError',code+';return load;')(
 {tasks:async()=>({tasks:[{id:'new'}],truncated:false}),task:async()=>{throw new Error('Detail unavailable');}},()=>()=>true,(v:boolean)=>loading=v,(e:unknown)=>error=e,'','', 'missing',(v:unknown)=>board=v,()=>{},()=>{},(e:Error)=>e.message);
 await load();expect(board).toEqual([{id:'new'}]);expect(error).toBe('Detail unavailable');expect(loading).toBe(false);
});
