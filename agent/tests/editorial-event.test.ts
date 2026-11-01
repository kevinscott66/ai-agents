import {test,expect} from 'bun:test';
import {verdictFrom,blocking} from '../lib/fact-check.ts';
const url='https://x.com/initia/status/2113661738625155217';
const subject={title:'Initia остановила L1 и роллапы после инцидента безопасности',requireEvent:true,items:[{text:'Initia',url}]};
test('absence of factual complaints alone is not evidence of an event',()=>{
 for(const decision of [{},{event_supported:false},{event_supported:true},{event_supported:true,event_evidence_url:'https://unopened.example'}]) {
  const verdict=verdictFrom({problems:[],sources_opened:[url],...decision},[],subject);
  expect(blocking(verdict.problems).some(p=>p.where==='title')).toBe(true);
 }
});
test('a supported event with its opened primary source passes the event gate',()=>{
 const verdict=verdictFrom({problems:[],sources_opened:[url],event_supported:true,event_evidence_url:url},[],subject);
 expect(blocking(verdict.problems)).toHaveLength(0);
});
