import { isMacOnline } from './mac-bridge.ts';
import { githubConfigured } from './github.ts';
import { githubMcpConfigured } from './github-mcp.ts';
import { webSearchEnabled } from './web-search.ts';
/** Configuration and bridge evidence only; never claims logged-in provider sessions. */
export function capabilityStatus(){
 const enabled=(key:string)=>process.env[key]==='true';
 return {scope:'configuration-and-bridge',checkedAt:new Date().toISOString(),integrations:[
  {id:'team-mcp',implemented:true,verification:'transport-depends-on-active-model-provider'},
  {id:'web-search',configured:webSearchEnabled(),verification:'configuration-only'},
  {id:'github-rest',configured:githubConfigured(),verification:'configuration-only'},
  {id:'github-mcp',configured:githubMcpConfigured(),verification:'configuration-only'},
  {id:'mac',connected:isMacOnline(),verification:'bridge-heartbeat'},
  ...[['yandex-taxi','TAXI_ENABLED'],['yandex-shopping','SHOP_ENABLED'],['yandex-delivery','DELIVERY_ENABLED']].map(([id,key])=>({id,configured:enabled(key),executor:'mac',verification:'provider-session-not-checked'})),
  {id:'higgsfield-mcp',configured:!!process.env.HIGGSFIELD_CREDENTIALS_FILE,verification:'credential-file-not-checked'},
  {id:'tbank-personal',configured:false,verification:'executor-not-implemented',next:'local-iPhone-preparation-and-owner-bank-confirmation'},
 ],note:'Configured does not mean authorized or reachable. Use the service preflight before execution. Tools remain subject to per-turn exposure, permissions and owner approval.'};
}
