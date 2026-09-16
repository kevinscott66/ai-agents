import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SAFE_PROBE_ENV = new Set(['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING','MAX_THINKING_TOKENS','CLAUDE_CODE_DISABLE_1M_CONTEXT']);

export function supportsIsolatedClaudeProbe(project:string, env:Record<string,string|undefined>):boolean {
  return isolatedClaudeProbeEnv(project,env) !== null;
}

/** Isolated probes must not test a different backend/model/auth helper. */
export function isolatedClaudeProbeEnv(project: string, env: Record<string,string|undefined>): Record<string,string> | null {
  if (!env.HOME) return null;
  const overrides:Record<string,string> = {};
  const files = new Set<string>([join(env.HOME,'.claude','settings.json'),join(env.HOME,'.claude','settings.local.json'),join(env.HOME,'.claude.json')]);
  const ancestors:string[]=[];
  for(let dir=resolve(project);;dir=dirname(dir)) {
    ancestors.unshift(dir);
    if(dirname(dir)===dir) break;
  }
  for(const dir of ancestors){
    files.add(join(dir,'.claude','settings.json'));
    files.add(join(dir,'.claude','settings.local.json'));
  }
  const managed = '/Library/Application Support/ClaudeCode';
  files.add(join(managed,'managed-settings.json'));
  try {
    for(const name of readdirSync(join(managed,'managed-settings.d'))) if(name.endsWith('.json')) files.add(join(managed,'managed-settings.d',name));
  } catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  for(const file of files) {
    let text:string;
    try { text=readFileSync(file,'utf8'); }
    catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')continue;return null; }
    if(text.length>1_048_576) return null;
    let value:unknown;
    try {value=JSON.parse(text);}catch{return null;}
    // ~/.claude.json contains historical project records and feature/model
    // caches. Inspect effective root/current-project options, not cache entries.
    if(file === join(env.HOME,'.claude.json')) {
      if(!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const config=value as Record<string,any>;
      const fields=['model','modelOverrides','availableModels','apiKeyHelper','apiKey','primaryApiKey','awsAuthRefresh','awsCredentialExport','forceLoginMethod','forceLoginOrgUUID','apiBaseUrl','baseUrl','env'];
      const effective:Record<string,unknown>={};
      for(const source of [config,...ancestors.map(path=>config.projects?.[path])]) {
        if(!source || typeof source!=='object') continue;
        for(const key of fields) if(key in source) effective[key]=source[key];
      }
      value=effective;
    }
    if(!isProbeCompatibleConfig(value)) return null;
    const settings = value as Record<string,unknown>;
    if(settings.env && typeof settings.env==='object') {
      for(const [key,setting] of Object.entries(settings.env)) {
        if(SAFE_PROBE_ENV.has(key) && typeof setting==='string') overrides[key]=setting;
      }
    }
  }
  return overrides;
}

/** Inspect keys only; never return, log or copy configuration/credential values. */
export function isProbeCompatibleConfig(value:unknown): boolean {
  if(!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const relevant = new Set(['model','modelOverrides','availableModels','apiKeyHelper','apiKey','primaryApiKey','awsAuthRefresh','awsCredentialExport','forceLoginMethod','forceLoginOrgUUID','apiBaseUrl','baseUrl']);
  const visit=(node:unknown):boolean=>{
    if(!node || typeof node!=='object') return true;
    for(const [key,child] of Object.entries(node)) {
      if(relevant.has(key) && child !== null && child !== undefined && child !== '') return false;
      if(key==='env' && child && (typeof child !== 'object' || Object.entries(child).some(([name,setting])=>!SAFE_PROBE_ENV.has(name) || typeof setting!=='string'))) return false;
      if(!visit(child)) return false;
    }
    return true;
  };
  return visit(value);
}
