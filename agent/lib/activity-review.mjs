/** Versioned content binding shared verbatim with the site/editor counterpart.
 * This is review metadata, not a cryptographic signature or a live-status claim.
 */
import { createHash } from 'node:crypto';

const FIELDS = ['id', 'project', 'title', 'date', 'intro', 'whatIs', 'steps',
  'raised', 'investors', 'spent', 'time', 'rewardType', 'status', 'dateReceive',
  'deadlineAt', 'url', 'sourceUrl', 'origin', 'hashtags'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value ?? null;
}

export function activityFingerprint(row) {
  return createHash('sha256').update(JSON.stringify(
    Object.fromEntries(FIELDS.map(field => [field, canonical(row?.[field])])),
  )).digest('hex');
}

export function activityReviewReceipt(input, published, now = Date.now()) {
  return { version: 1, inputHash: activityFingerprint(input), outputHash: activityFingerprint(published),
    boundAt: new Date(now).toISOString() };
}

export function activityReviewMatches(input, published, receipt, now = Date.now()) {
  const checkedAt = Date.parse(receipt?.boundAt ?? '');
  return receipt?.version === 1 && Number.isFinite(checkedAt) && checkedAt <= now &&
    receipt.inputHash === activityFingerprint(input) && receipt.outputHash === activityFingerprint(published);
}
