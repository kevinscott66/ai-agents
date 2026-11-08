import {test,expect} from 'bun:test';
import {relatedPublications} from '../lib/editorial-history.ts';
import {factCheckPrompt,verdictFrom} from '../lib/fact-check.ts';
import {isDuplicate} from '../tools/daily-draft.ts';
const prior={id:'nov5',title:'Kinetiq назначила запуск mainnet Elysium на 9 ноября',summary:'Запуск сети Elysium запланирован на 9 ноября 2026 года.',date:'2026-11-05'};
test('related event history spans different wording but excludes current record and unrelated companies',()=>{
 expect(relatedPublications('Elysium назначил запуск мейннета на 9 ноября',[prior])).toEqual([prior]);
 expect(relatedPublications('Elysium запустил сеть',[prior],'nov5')).toEqual([]);
 expect(relatedPublications('Компания купила разработчика',[prior])).toEqual([]);
 expect(isDuplicate('Ethereum Foundation открыла программу',['Ethereum Foundation уволила 54 человека и режет бюджет на 40%'])).toBe(false);
 expect(relatedPublications('Яндекс выпустил новую модель',[{id:'ya',title:'Яндекс открыл доступ к прежней модели'}])).toHaveLength(1);
 expect(isDuplicate('OpenAI договорилась купить Pierre Computer Company',['NVIDIA договорилась купить Hugging Face'])).toBe(false);
});
test('novelty needs an independently opened source and cannot be approved by missing or self-asserted metadata',()=>{
 const url='https://project.org/launch',c={title:'Elysium запустил мейннет',requireEvent:true,priorPublications:[prior],items:[{text:'Announcement',url}]};
 const base={problems:[],sources_opened:[url],event_supported:true,event_evidence_url:url};
 for(const extra of [{},{event_novel:false,novelty_evidence_url:url},{event_novel:true,novelty_evidence_url:'https://other.org/'}])
  expect(verdictFrom({...base,...extra},[],c).problems.some(p=>p.issue.includes('инфоповод'))).toBe(true);
 expect(verdictFrom({...base,event_novel:true,novelty_evidence_url:url},[],c).problems).toEqual([]);
 expect(factCheckPrompt(c)).toContain('новый сезон');
 expect(factCheckPrompt(c)).toContain('напоминание «завтра»');
});
