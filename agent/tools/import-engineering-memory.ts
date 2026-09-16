/** Local operator command. No networking, inference, message sending or deployment. */
import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeKnowledge } from '../lib/native-knowledge.ts';
import { parseEngineeringBundle } from '../lib/engineering-memory.ts';

export function importEngineeringCommand(args:string[]) {
  process.umask(0o077);
  const allowed=new Set(['--bundle','--db','--owner','--sole-owner','--apply','--owner-approval','--expected-sha256','--backup']);
  const flags=new Map<string,string>();
  for(let i=0;i<args.length;i++){
    const key=args[i];if(!allowed.has(key)||flags.has(key))throw new Error('invalid_arguments');
    if(['--sole-owner','--apply','--owner-approval'].includes(key))flags.set(key,'true');
    else {const value=args[++i];if(!value||value.startsWith('--'))throw new Error('missing_argument');flags.set(key,value);}
  }
  if(!flags.has('--bundle')||!flags.has('--db')||flags.has('--owner')===flags.has('--sole-owner'))throw new Error('required: --bundle PATH --db PATH and exactly one of --owner ID / --sole-owner');
  const payload=readFileSync(resolve(flags.get('--bundle')!), 'utf8');
  const bundle=parseEngineeringBundle(payload),sha256=createHash('sha256').update(payload).digest('hex');
  const path=resolve(flags.get('--db')!);if(!existsSync(path))throw new Error('database_missing');
  const apply=flags.has('--apply');
  if(apply&&(!flags.has('--owner-approval')||flags.get('--expected-sha256')!==sha256||!flags.has('--backup')))throw new Error('apply_requires_owner_approval_expected_hash_and_backup');
  const db=new Database(path,apply?{readwrite:true,create:false}:{readonly:true});
  try {
    db.run('PRAGMA busy_timeout=5000');
    let user=flags.get('--owner');
    if(flags.has('--sole-owner')){
      const owners=db.query('SELECT DISTINCT user_id FROM conversations LIMIT 2').all() as {user_id:string}[];
      if(owners.length!==1)throw new Error('ambiguous_owner');user=owners[0].user_id;
    }
    if(!db.query('SELECT 1 FROM conversations WHERE user_id=? LIMIT 1').get(user!))throw new Error('unknown_owner');
    if(!apply)return {mode:'DRY_RUN',batchId:bundle.batchId,sha256,projects:bundle.projects.map(p=>({key:p.key,title:p.title,entries:p.entries.length}))};
    const backup=resolve(flags.get('--backup')!);if(existsSync(backup)||backup===path)throw new Error('backup_must_be_new');
    db.query('VACUUM INTO ?').run(backup);chmodSync(backup,0o600);
    const result=new NativeKnowledge(db).engineering.importBundle(user!,bundle,true);
    return {mode:'APPLIED',...result,backup};
  }finally{db.close();}
}
if(import.meta.main){
  try{console.log(JSON.stringify(importEngineeringCommand(process.argv.slice(2)),null,2));}
  catch(error){console.error(error instanceof Error?error.message:'import_failed');process.exitCode=1;}
}
