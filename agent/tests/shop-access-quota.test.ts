import { test, expect } from 'bun:test';
import { executeTool } from '../lib/tools-schema.ts';
import { checkAndConsumeRateLimit, _resetRateLimits } from '../lib/rate-limits.ts';
import { db } from '../lib/db.ts';

test('group shopping refusals stay audited without exhausting private shopping quota', async () => {
  const before = { enabled: process.env.SHOP_ENABLED, owners: process.env.MINIAPP_ADMIN_USER_IDS };
  const chatId = -100009242;
  process.env.SHOP_ENABLED = 'true';
  process.env.MINIAPP_ADMIN_USER_IDS = '424242';
  _resetRateLimits();
  try {
    for (let i = 0; i < 5; i++) {
      const out = JSON.parse(await executeTool('SHOP_PLACES', { query: 'бургер' }, {
        agentKey: 'orchestrator', chatId, triggerUserId: '424242',
      }));
      expect(out.error).toContain('forbidden');
    }
    expect((db.query('SELECT COUNT(*) AS n FROM agent_actions WHERE chat_id=? AND action_type=?').get(chatId, 'SHOP_PLACES') as { n: number }).n).toBe(5);
    for (let i = 0; i < 4; i++) expect(checkAndConsumeRateLimit('orchestrator', 'SHOP_PLACES').ok).toBe(true);
    expect(checkAndConsumeRateLimit('orchestrator', 'SHOP_PLACES').ok).toBe(false);
  } finally {
    for (const [key, value] of Object.entries({ SHOP_ENABLED: before.enabled, MINIAPP_ADMIN_USER_IDS: before.owners })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    db.query('DELETE FROM agent_actions WHERE chat_id=?').run(chatId);
    _resetRateLimits();
  }
});
