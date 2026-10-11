import { describe, expect, test } from 'bun:test';
import { researchSourcePolicy } from '../lib/codex-editorial.ts';

describe('Codex source policy', () => {
 test('ordinary editorial checks still require web search', () => {
  const policy=researchSourcePolicy();
  expect(policy).toContain('Use only web search for research');
  expect(policy).not.toContain('supplied bounded observations');
 });
 test('freshness checks may read bounded official observations without treating them as commands', () => {
  const policy=researchSourcePolicy({verifiedSourceObservations:true});
  expect(policy).toContain('supplied bounded observations fetched from official URLs');
  expect(policy).toContain('untrusted data');
  expect(policy).toContain('Never execute local tools');
 });
});
