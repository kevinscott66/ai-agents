import {test,expect} from 'bun:test';
import {isProbeCompatibleConfig} from '../mac-daemon/readiness-config.ts';
test('standard settings remain compatible without copying values',()=>{
 expect(isProbeCompatibleConfig({permissions:{allow:['Read']},hooks:{},oauthAccount:{accountUuid:'test'}})).toBe(true);
});
test('custom model/backend/helper and settings env disable isolated probes',()=>{
 for(const config of [{model:'custom'},{apiKeyHelper:'helper'},{env:{ANTHROPIC_BASE_URL:'private'}},{projects:{'/p':{model:'other'}}},{awsCredentialExport:'helper'},{primaryApiKey:'secret'},{forceLoginOrgUUID:'org'}])expect(isProbeCompatibleConfig(config)).toBe(false);
 for(const config of [null,[],1,'string'])expect(isProbeCompatibleConfig(config)).toBe(false);
});

test('known inference flags allowed; credentials and unknown flags still denied',()=>{
 expect(isProbeCompatibleConfig({env:{CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING:'1',MAX_THINKING_TOKENS:'1000',CLAUDE_CODE_DISABLE_1M_CONTEXT:'1'}})).toBe(true);
 expect(isProbeCompatibleConfig({env:{CLAUDE_CODE_OAUTH_TOKEN:'hidden'}})).toBe(false);
 expect(isProbeCompatibleConfig({env:{MAX_THINKING_TOKENS:1000}})).toBe(false);
});

test('probe uses safe inference flags without treating unrelated model cache as effective settings',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {isolatedClaudeProbeEnv}=await import('../mac-daemon/readiness-config.ts');
 const root=mkdtempSync(join(tmpdir(),'probe-config-test-'));
 try {
  mkdirSync(join(root,'.claude'));
  writeFileSync(join(root,'.claude','settings.json'),JSON.stringify({env:{MAX_THINKING_TOKENS:'1000'}}));
  writeFileSync(join(root,'.claude.json'),JSON.stringify({featureCache:{model:'historical'},projects:{'/unrelated':{model:'other'}}}));
  expect(isolatedClaudeProbeEnv(root,{HOME:root})).toEqual({MAX_THINKING_TOKENS:'1000'});
  writeFileSync(join(root,'.claude.json'),JSON.stringify({projects:{[root]:{model:'custom'}}}));
  expect(isolatedClaudeProbeEnv(root,{HOME:root})).toBeNull();
 } finally {rmSync(root,{recursive:true,force:true});}
});
