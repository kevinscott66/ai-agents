import { test, expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { createAssistantHealthAlerts } from '../lib/assistant-alerts.ts';
import type { HealthSnapshot } from '../lib/health.ts';
test('health alerts require opt-in, debounce failure and stay quiet until recovery', async () => {
  const store = new NativeAccess(':memory:');
  try {
    const messages: string[] = [];
    const deliver = createAssistantHealthAlerts(async (_u, text) => { messages.push(text); return true; }, () => store, () => true);
    const down = { agentKey: 'qa', alive: false, consecutiveFailures: 3 } as HealthSnapshot;
    await deliver([down]); expect(messages.length).toBe(0);
    store.alerts('123', true);
    await deliver([{ ...down, consecutiveFailures: 2 }]); expect(messages.length).toBe(0);
    await deliver([down]); await deliver([down]); expect(messages.length).toBe(1);
    await deliver([{ ...down, alive: true, consecutiveFailures: 0 }]);
    await deliver([{ ...down, alive: true, consecutiveFailures: 0 }]);
    expect(messages.length).toBe(2); expect(messages[1]).toContain('восстановлена');
    store.alerts('123', false); await deliver([down]); expect(messages.length).toBe(2);
  } finally { store.db.close(); }
});

test('removing owner from Telegram allowlist stops personal alerts even if Mac permission remains', async () => {
  const saved = {MAC_USER_IDS:process.env.MAC_USER_IDS, TELEGRAM_ALLOWED_GROUP_IDS:process.env.TELEGRAM_ALLOWED_GROUP_IDS};
  const store = new NativeAccess(':memory:');
  try {
    process.env.MAC_USER_IDS = '999323992';
    process.env.TELEGRAM_ALLOWED_GROUP_IDS = '999323992';
    store.alerts('999323992', true);
    const messages: string[] = [];
    const deliver = createAssistantHealthAlerts(async (_user,text) => {messages.push(text);return true;}, () => store);
    const down = {agentKey:'qa',alive:false,consecutiveFailures:3} as HealthSnapshot;
    process.env.TELEGRAM_ALLOWED_GROUP_IDS = '';
    await deliver([down]);
    expect(messages).toEqual([]);
    process.env.TELEGRAM_ALLOWED_GROUP_IDS = '999323992';
    await deliver([down]);
    expect(messages).toHaveLength(1);
  } finally {
    store.db.close();
    for (const [key,value] of Object.entries(saved)) {if(value === undefined) delete process.env[key];else process.env[key]=value;}
  }
});
