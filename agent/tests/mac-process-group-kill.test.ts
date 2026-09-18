import {test,expect} from 'bun:test';
import {killChild} from '../mac-daemon/kill.ts';

test('cancel kills a SIGINT-resistant grandchild even after its CLI parent exits', async () => {
  const grandchild = `process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000);`;
  const parent = `const child=Bun.spawn({cmd:[process.execPath,'-e',${JSON.stringify(grandchild)}],stdout:'pipe',stderr:'ignore'});await child.stdout.getReader().read();process.on('SIGINT',()=>process.exit(0));console.log(child.pid);setInterval(()=>{},1000);`;
  const child = Bun.spawn({cmd:[process.execPath,'-e',parent],detached:true,stdout:'pipe',stderr:'ignore'});
  let descendant:number|undefined;
  try {
    const ready = await Promise.race([child.stdout.getReader().read(),Bun.sleep(3000).then(()=>{throw new Error('child startup timeout');})]);
    descendant = Number(new TextDecoder().decode(ready.value).trim());
    expect(Number.isSafeInteger(descendant) && descendant! > 1).toBe(true);
    expect(await killChild({kill:signal=>child.kill(signal),exited:child.exited,processGroupId:child.pid},50)).toBe('killed');
    await child.exited;
    let alive = true;
    for(let i=0;i<50 && alive;i++) {
      try {process.kill(descendant!,0);} catch(error) {
        if((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        alive=false;
      }
      if(alive) await Bun.sleep(20);
    }
    expect(alive).toBe(false);
  } finally {
    try {process.kill(-child.pid,'SIGKILL');} catch {}
    if(descendant && descendant>1) {try {process.kill(descendant,'SIGKILL');} catch {}}
    await child.exited;
  }
});

// macOS: kill(-pgid, 0) отвечает EPERM, когда в группе одни зомби. Раньше это
// пробрасывалось из `void killChild(...)` и роняло демон на отмене прогона.
test('EPERM from a zombie-only process group counts as exited, not a crash', async () => {
  const real = process.kill;
  const eperm = () => Object.assign(new Error('kill() failed: EPERM'), {code: 'EPERM'});
  let sigints = 0;
  (process as any).kill = (pid: number, sig?: number | NodeJS.Signals) => {
    if (pid !== -424242) return real.call(process, pid, sig as any);
    if (sig === 'SIGINT') { sigints++; return true; }
    throw eperm();
  };
  try {
    const child = {kill: () => {}, exited: Promise.resolve(), processGroupId: 424242};
    expect(await killChild(child, 50)).toBe('exited');
    expect(sigints).toBe(1);
    (process as any).kill = (pid: number, sig?: number | NodeJS.Signals) => {
      if (pid !== -424242) return real.call(process, pid, sig as any);
      throw eperm();
    };
    expect(await killChild(child, 50)).toBe('gone');
  } finally {
    (process as any).kill = real;
  }
});
