import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {editorialResearch} from '../lib/codex-editorial.ts';

// Exercise the actual subprocess adapter, without credentials or network calls.
test('direct hosted search preserves capability restrictions and tool errors fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'editorial-adapter-contract-'));
 const old={CODEX_BIN:process.env.CODEX_BIN,CODEX_AUTH_HOME:process.env.CODEX_AUTH_HOME};
 try {
  const cli=join(dir,'codex');
  await writeFile(cli,`#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli 0.149.0');process.exit(0)}
if(a[0]==='debug'){console.log(JSON.stringify({models:[{slug:'gpt-5.6-terra',supported_in_api:true,tool_mode:'code_mode_only'}]}));process.exit(0)}
let p='';process.stdin.on('data',s=>p+=s);process.stdin.on('end',()=>{
 const c=a.find(v=>v.startsWith('model_catalog_json='));
 const m=JSON.parse(fs.readFileSync(JSON.parse(c.slice('model_catalog_json='.length)),'utf8')).models[0];
 const disabled=['shell_tool','unified_exec','apps','plugins','hooks','view_image','code_mode','code_mode_host'];
 if(m.tool_mode!=='direct'||m.apply_patch_tool_type!==null||!disabled.every(v=>a.some((x,i)=>x==='--disable'&&a[i+1]===v))||!a.includes('read-only')||!a.includes('web_search="live"'))process.exit(2);
 if(p.includes('CHECK_IMAGE')){
  const file=a[a.indexOf('--image')+1];
  if(!file||!p.includes('pbs.twimg.com/media/test.jpg')||(fs.statSync(file).mode&511)!==384||fs.readFileSync(file)[0]!==255)process.exit(3);
 }
 const emit=e=>console.log(JSON.stringify(e));
 emit({type:'turn.started'});
 if(p.includes('UNAVAILABLE'))emit({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled.'}});
 else if(p.includes('LOCAL_TOOL'))emit({type:'item.completed',item:{type:'command_execution',command:'not executed'}});
 else emit({type:'item.completed',item:{type:'web_search',query:'official project'}});
 emit({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}});
 emit({type:'turn.completed'});
});
`,{mode:0o700});
  process.env.CODEX_BIN=cli;process.env.CODEX_AUTH_HOME=dir;
  expect(await editorialResearch('Research','source')).toBe('{"ok":true}');
  expect(await editorialResearch('Research','CHECK_IMAGE',{images:[{url:'https://pbs.twimg.com/media/test.jpg',mediaType:'image/jpeg',bytes:Uint8Array.from([255,216,255])}]})).toBe('{"ok":true}');
  await expect(editorialResearch('Research','UNAVAILABLE')).rejects.toThrow('tool configuration failed');
  await expect(editorialResearch('Research','LOCAL_TOOL')).rejects.toThrow('Unexpected editorial tool');
 } finally {
  for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;
  await rm(dir,{recursive:true,force:true});
 }
},30_000);
