import { test, expect } from 'bun:test';
import { shopSearchRunBlocked, noteIncompleteShopSearch } from '../lib/shop-search-run.ts';
import { executeTool } from '../lib/tools-schema.ts';

test('unreadable catalogue blocks only the originating trusted request', () => {
  const ctx = { requestId: 'catalogue-test', agentKey: 'orchestrator', chatId: 42, triggerUserId: '42' };
  noteIncompleteShopSearch(ctx, 1000);
  expect(shopSearchRunBlocked(ctx, 1001)).toBe(true);
  expect(shopSearchRunBlocked({ ...ctx, requestId: 'new-turn' }, 1001)).toBe(false);
  expect(shopSearchRunBlocked({ ...ctx, chatId: 43 }, 1001)).toBe(false);
  expect(shopSearchRunBlocked({ ...ctx, triggerUserId: '43' }, 1001)).toBe(false);
  expect(shopSearchRunBlocked(ctx, 901001)).toBe(false);
});

test('incomplete catalogue cannot schedule a blind retry in the same turn', async () => {
  const ctx = { requestId: 'catalogue-schedule-test', agentKey: 'orchestrator', chatId: 424242, triggerUserId: '424242' };
  noteIncompleteShopSearch(ctx);
  const out = JSON.parse(await executeTool('SCHEDULE_FOLLOWUP', {}, ctx));
  expect(out.code).toBe('search_incomplete');
});
