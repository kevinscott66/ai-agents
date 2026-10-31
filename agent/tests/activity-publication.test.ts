import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activityReviewReceipt} from '../lib/activity-review.mjs';
import {checkActivityPublication,pickPending,publicationSubject,readEditorialCandidates,withJournalEditorial,type EditorialFile} from '../tools/site-editorial.ts';

const raw={id:'testnet',title:'Original testnet campaign',intro:'Original raw intro',steps:['Read terms.'],url:'https://example.com/terms',spent:'Unknown',origin:'telegram',activityReviewRequired:true};
const proposal={title:'Fixture открыл тестнет для проверки обменов токенов',intro:'Подтверждённые условия участия. '.repeat(12).trim()};

test('private intake never falls back to public activities and validates both queues before writing',()=>{
 const tree=mkdtempSync(join(tmpdir(),'editorial-intake-'));
 try {
  const dir=join(tree,'src/data/current');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'editorial-candidates.json'),'[]');writeFileSync(join(dir,'activities.json'),'[]');
  expect(()=>readEditorialCandidates(tree)).toThrow('activity-candidates.json');
  writeFileSync(join(dir,'activity-candidates.json'),'{}');expect(()=>readEditorialCandidates(tree)).toThrow('Invalid editorial corpus');
  writeFileSync(join(dir,'activity-candidates.json'),JSON.stringify([raw]));
  expect(readEditorialCandidates(tree).activities).toEqual([raw]);
  writeFileSync(join(dir,'activity-candidates.json'),JSON.stringify([{...raw,activityReviewRequired:undefined}]));
  expect(()=>readEditorialCandidates(tree)).toThrow('publication-review state');
 } finally {rmSync(tree,{recursive:true,force:true});}
});

test('old automatic intros and partial manual edits cannot prevent review of unpublished or changed terms',()=>{
 const auto: EditorialFile={activities:{[raw.id]:{...proposal,editorialVersion:3}}};
 const manual={activities:{[raw.id]:{title:'Retained manual title',intro:'Retained manual intro'}}};
 expect(pickPending([raw],manual,auto,'activities').map(r=>r.id)).toEqual([raw.id]);
 const published={...raw,...proposal};
 auto.activities![raw.id].activityReview=activityReviewReceipt(raw,published);
 expect(pickPending([raw],{},auto,'activities')).toEqual([]);
 expect(pickPending([{...raw,steps:['Deposit funds']}],{},auto,'activities')).toHaveLength(1);
 expect(pickPending([{...raw,origin:'api'}],{}, {},'activities')).toHaveLength(1);
 expect(pickPending([{...raw,activityReviewRequired:false}],manual,{},'activities')).toEqual([]);
 expect(pickPending([raw],manual,{},'activities',2,{['activities:'+raw.id]:Date.now()+60000})).toEqual([]);
});

test('final verifier sees retained manual copy, sensitive conditions and the explicit activity kind',async()=>{
 const manual={title:'Ручной заголовок об условиях тестирования',intro:'Сохранённое человеком описание. '.repeat(12)};
 const errors=await checkActivityPublication(proposal,raw,manual,async(entry,input,kind)=>{
  expect(entry).toEqual({...manual,intro:manual.intro.trim()});expect(input.steps).toEqual(raw.steps);expect(kind).toBe('activities');
  return ['Unsupported retained deposit terms'];
 });
 expect(errors).toEqual(['Unsupported retained deposit terms']);
 const allowed=await checkActivityPublication(proposal,raw,manual,async()=>[]);expect(allowed).toEqual([]);
 let called=false;
 expect((await checkActivityPublication({...proposal,intro:'Short'},raw,{},async()=>{called=true;return []})).length).toBeGreaterThan(0);
 expect(called).toBe(false);
 const journal=[{kind:'activity',op:'patch',key:raw.id,value:{title:manual.title,intro:manual.intro}}];
 expect(withJournalEditorial({},journal).activities?.[raw.id]).toEqual(manual);
});

test('verifier receives the funding, reward date and deadline which the content binding covers',()=>{
 const subject=publicationSubject(proposal,{...raw,raised:'$10 million',investors:'Investor A',dateReceive:'2027 Q1',deadlineAt:'2026-11-01T23:00:00Z'},'activities');
 for(const value of ['$10 million','Investor A','2027 Q1','2026-11-01T23:00:00Z'])expect(subject.body).toContain(value);
});


test('remove then re-add does not resurrect an old protected manual intro',()=>{
 const manual={activities:{[raw.id]:{title:'Old protected title',intro:'Old protected intro'}}};
 const journal=[{kind:'activity',op:'remove',key:raw.id},{kind:'activity',op:'add',key:raw.id,value:{title:'New campaign title'}}];
 expect(withJournalEditorial(manual,journal).activities?.[raw.id]).toEqual({title:'New campaign title'});
 expect(manual.activities[raw.id].intro).toBe('Old protected intro');
});

const revision = {
 version:1 as const, whatIs:'Тестовая площадка с виртуальными активами.',
 steps:['Откройте [официальные правила](https://example.com/terms).','Используйте только тестовые средства; реальные средства не требуются.'],
 spent:'', time:'', rewardType:'Условия приза указаны в правилах',status:'Потенциальный',
 dateReceive:'',deadlineAt:null,url:'https://example.com/terms',raised:'',investors:'',
};
const corrected = {...proposal,activityRevision:revision,items:[{text:'Правила',url:'https://example.com/terms'}]};

test('full revision checker sees corrected instructions and unknowns, not obsolete imported claims',async()=>{
 const input={...raw,steps:['Deposit $100 to get guaranteed tokens'],spent:'$100',rewardType:'Guaranteed airdrop'};
 const before=structuredClone(input);
 let calls=0;
 expect(await checkActivityPublication(corrected,input,{},async(entry,record,kind)=>{
  calls++;expect(kind).toBe('activities');expect(record.steps).toEqual(revision.steps);
  expect(record.spent).toBe('');expect(record.rewardType).toBe(revision.rewardType);
  const checked=publicationSubject(entry,record,kind);
  expect(checked.body).not.toContain('Deposit $100');expect(checked.body).not.toContain('Guaranteed airdrop');
  expect(checked.body).toContain('тестовые средства');expect(checked.items).toContainEqual(corrected.items[0]);
  return [];
 })).toEqual([]);
 expect(calls).toBe(1);expect(input).toEqual(before);
});

test('material human edits including empty unknown values are retained before the final check',async()=>{
 const manual=withJournalEditorial({},[{kind:'activity',op:'patch',key:raw.id,value:{steps:['Human deposit instruction'],spent:'',deadlineAt:null}}]).activities![raw.id];
 expect(await checkActivityPublication(corrected,raw,manual,async(_,record)=>{
  expect(record.steps).toEqual(['Human deposit instruction']);expect(record.spent).toBe('');expect(record.deadlineAt).toBe(null);
  return ['Human condition unsupported'];
 })).toEqual(['Human condition unsupported']);
});

test('new revision receipt is invalidated by a changed condition and does not requeue an unchanged accepted guide',async()=>{
 const {projectActivityRevision}=await import('../lib/activity-revision.mjs');
 const output=projectActivityRevision(raw,corrected);
 const entry={...corrected,activityReview:activityReviewReceipt(raw,output)};
 expect(pickPending([raw],{}, {activities:{[raw.id]:entry}},'activities')).toEqual([]);
 expect(pickPending([{...raw,steps:['New imported task']}],{}, {activities:{[raw.id]:entry}},'activities')).toHaveLength(1);
 expect(pickPending([raw],{activities:{[raw.id]:{title:proposal.title,spent:'$10'} as any}}, {activities:{[raw.id]:entry}},'activities')).toHaveLength(1);
});

test('malformed/identity-changing/unsafe revisions never call the independent checker',async()=>{
 for(const patch of [null,{}, {...revision,steps:{}},{...revision,steps:[]},{...revision,id:'new-id'},
  {...revision,spent:0},{...revision,url:'javascript:alert(1)'},{...revision,deadlineAt:'2026-11-01'},
  {...revision,steps:['[Click](data:text/html,bad)']},{...revision,whatIs:'<script>alert(1)</script>'}]) {
  let calls=0;
  const errors=await checkActivityPublication({...corrected,activityRevision:patch as any},raw,{},async()=>{calls++;return []});
  expect(errors.length).toBeGreaterThan(0);expect(calls).toBe(0);
 }
 expect((await checkActivityPublication({...corrected,items:[]},raw)).length).toBeGreaterThan(0);
});

test('a substantive factual rejection still blocks the full corrected proposal',async()=>{
 const result=await checkActivityPublication(corrected,raw,{},async()=>['No official current campaign']);
 expect(result).toEqual(['No official current campaign']);
});

test('invalid explicitly present revisions cannot strand a private guide behind a legacy receipt',()=>{
 const entry={...proposal,activityRevision:null as any,activityReview:activityReviewReceipt(raw,{...raw,...proposal})};
 expect(pickPending([raw],{}, {activities:{[raw.id]:entry}},'activities')).toHaveLength(1);
});

test('actual intake ownership beats a stale replay of a skipped journal patch',async()=>{
 const {projectActivityRevision}=await import('../lib/activity-revision.mjs');
 const input={...raw,activityManualFields:[],spent:'Original'};
 expect(projectActivityRevision(input,corrected,{spent:'obsolete $999'}).spent).toBe('');
 const human={...input,activityManualFields:['spent'],spent:''};
 expect(projectActivityRevision(human,corrected,{spent:'obsolete $999'}).spent).toBe('');
});

test('a generic overview cannot replace a source-backed program even with zero factual complaints',async()=>{
 const {verdictFrom}=await import('../lib/fact-check.ts');
 const subject=publicationSubject(corrected,{...raw,...revision} as any,'activities');
 expect(subject.requireActivity).toBe(true);
 const source=corrected.items[0].url;
 for(const fields of [{},{activity_supported:false},{activity_supported:true,activity_source_official:true,activity_evidence_url:'https://example.com/unopened'}]) {
  const verdict=verdictFrom({problems:[],sources_opened:[source],...fields},[],subject);
  expect(verdict.problems.some(p=>p.severity==='block')).toBe(true);
 }
 const checked=verdictFrom({problems:[],sources_opened:[source],activity_supported:true,activity_source_official:true,activity_evidence_url:source},[],subject);
 expect(checked.problems).toEqual([]);
});
