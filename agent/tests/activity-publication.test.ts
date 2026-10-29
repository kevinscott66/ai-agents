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
