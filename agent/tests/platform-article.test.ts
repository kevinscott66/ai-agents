import {test,expect} from 'bun:test';
import {platformArticle,ARTICLE_TEXT_LIMIT} from '../lib/platform-article.ts';
import {readSources} from '../lib/fact-check.ts';
const id='2115806309278777344',post='https://x.com/nadoHQ/status/2115828381329580065';
const fixture=()=>({text:`https://x.com/i/article/${id}`,author:{screen_name:'nadoHQ'},created_at:'2026-10-29',article:{id,title:'PRIME',preview_text:'Only the teaser',content:{blocks:[{text:'Launch in Q4. Trades via PRIME are charged 0% fees.',entityRanges:[{key:1}]}],entityMap:[{key:'1',value:{type:'LINK',data:{url:'https://docs.nado.xyz/prime'}}}]},cover_media:{media_info:{original_img_url:'https://pbs.twimg.com/media/cover.jpg'}}}});
test('attached article full blocks, attribution and media reach both writer/checker source records without new fetches',async()=>{
 const calls:string[]=[];
 const read=await readSources([{url:post}],(async u=>{calls.push(String(u));return Response.json({tweet:fixture()});}) as typeof fetch);
 expect(calls).toEqual(['https://api.fxtwitter.com/nadoHQ/status/2115828381329580065']);
 expect(read[0].url).toBe(post);expect(read[0].text).toContain('Запись @nadoHQ от 2026-10-29');
 expect(read[0].text).toContain('0% fees');expect(read[0].text).toContain('https://docs.nado.xyz/prime');
 expect(read[0].text).not.toContain('Only the teaser');expect(read[0].media?.[0].url).toBe('https://pbs.twimg.com/media/cover.jpg');
});
test('preview-only, malformed and mismatched articles never masquerade as a full primary text',()=>{
 const t=fixture();
 expect(platformArticle({...t,text:'https://x.com/i/article/2115806309278777345'})).toBeNull();
 expect(platformArticle({...t,text:`https://x.com/i/article/${id}evil`})).toBeNull();
 expect(platformArticle({...t,article:{...t.article,content:{blocks:[]}}})).toBeNull();
 expect(platformArticle({...t,article:{...t.article,content:{blocks:[{text:42}]}}})).toBeNull();
 expect(platformArticle({...t,article:{id:'bad',preview_text:'Teaser'}})).toBeNull();
});
test('large articles are explicitly bounded and arbitrary entity URLs are never executed or fetched',()=>{
 const t=fixture();t.article.content.blocks[0].text='A'.repeat(ARTICLE_TEXT_LIMIT+1000);
 t.article.content.entityMap[0].value.data.url='javascript:alert(1)';
 const result=platformArticle(t)!;
 expect(result.text.length).toBeLessThan(ARTICLE_TEXT_LIMIT+1000);expect(result.text).toContain('Текст статьи ограничен');
 expect(result.text).not.toContain('javascript:');
});
