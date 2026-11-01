import {expect,test} from 'bun:test';
import {renderDailyBanner} from '../tools/daily-draft.ts';
import {dayTitle} from '../lib/daily-draft-format.ts';
import {channelDailyText} from '../lib/channel-daily-spec.ts';

test('daily reference keeps one complete headline in caption and clean 1920×1008 cover',async()=>{
 const a={title:'Платформа открыла проверку права на участие и назвала окончательный срок регистрации для пользователей',date:'2026-10-30',summary:'**30 октября** команда открыла проверку права на участие. Пользователи могут проверить свои данные на официальном сайте и ознакомиться с опубликованными условиями; **срок регистрации** указан в объявлении.',body:('Подтверждённый текст с условиями участия и датами. '.repeat(7)+'\n\n'+'Дополнительные сведения из проверенных источников. '.repeat(7)),items:[{text:'Официальный анонс',url:'https://example.com/announcement'},{text:'Проверка',url:'https://example.net/news'}],sourceCount:2,emoji:'🔥'};
 const title=dayTitle([a]);expect(title.length).toBeGreaterThan(90);expect(title).toBe(a.title);
 const text=channelDailyText(title,'2026-10-30T08:00:00Z',[a]);
 expect(text.split('\n')[0]).toBe(`📰 **${a.title}**`);expect(text).toContain(`\n🔥 **${a.title}**\n`);
 const png=await renderDailyBanner({title,subtitle:'Свежее в крипте и AI',date:'30 октября 2026',tag:'AI × Web3'});
 expect(png.subarray(1,4).toString()).toBe('PNG');expect(png.readUInt32BE(16)).toBe(1920);expect(png.readUInt32BE(20)).toBe(1008);
},15000);
