/** Shared activity revision contract. Source identity/dates remain immutable.
 * A revision is never approval: the full projected record needs a matching receipt.
 */
export const ACTIVITY_TERM_FIELDS = ['whatIs', 'steps', 'spent', 'time', 'rewardType',
  'status', 'dateReceive', 'deadlineAt', 'url', 'raised', 'investors'];
const TEXT_FIELDS = ACTIVITY_TERM_FIELDS.filter(key => !['steps', 'deadlineAt'].includes(key));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
export function activityHttpUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
export function activityRevisionErrors(revision) {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision) || revision.version !== 1)
    return ['activityRevision: требуется версия 1'];
  const errors = [];
  for (const key of Object.keys(revision))
    if (key !== 'version' && !ACTIVITY_TERM_FIELDS.includes(key)) errors.push(`activityRevision: запрещено поле ${key}`);
  for (const key of TEXT_FIELDS)
    if (typeof revision[key] !== 'string' || revision[key].length > 4000) errors.push(`activityRevision.${key}: требуется строка (пустая означает неизвестно)`);
  if (!Array.isArray(revision.steps) || !revision.steps.length || revision.steps.length > 20 ||
      revision.steps.some(step => typeof step !== 'string' || !step.trim() || step.length > 2000))
    errors.push('activityRevision.steps: нужны 1–20 непустых шагов');
  if (!activityHttpUrl(revision.url)) errors.push('activityRevision.url: требуется http(s) без credentials');
  if (!['Потенциальный', 'Подтверждён', 'Не проверено', 'Завершено', 'Приостановлено'].includes(revision.status))
    errors.push('activityRevision.status: неизвестный статус');
  if (revision.deadlineAt !== null && (typeof revision.deadlineAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(revision.deadlineAt) ||
      !Number.isFinite(Date.parse(revision.deadlineAt)))) errors.push('activityRevision.deadlineAt: ISO timestamp с timezone или null');
  for (const text of [...TEXT_FIELDS.map(key => revision[key]), ...(Array.isArray(revision.steps) ? revision.steps : [])]) {
    if (typeof text !== 'string') continue;
    if (/<\/?[a-z][^>]*>/i.test(text)) errors.push('activityRevision: HTML запрещён, используй Markdown');
    for (const match of text.matchAll(/\]\(([^\s)]+)\)/g))
      if (!activityHttpUrl(match[1])) errors.push('activityRevision: ссылка не по http(s)');
  }
  return errors;
}

/** The writer, checker, queue selector and builder must project the same fields.
 * Human ownership includes explicit empty/null values; input is never mutated.
 * Invalid revisions are ignored here and fail their receipt/form checks elsewhere.
 */
export function projectActivityRevision(input, proposal = {}, manual = {}) {
  const output = { ...input };
  // The private intake records actual human ownership after applicable journal
  // operations. Its values, not a stale replay of skipped patches, are final.
  if (Array.isArray(input?.activityManualFields)) manual = Object.fromEntries(
    input.activityManualFields.map(key => [key, input[key]]),
  );
  const revision = proposal.activityRevision;
  if (revision && !activityRevisionErrors(revision).length) {
    for (const key of ACTIVITY_TERM_FIELDS) {
      const value = own(manual, key) ? manual[key] : revision[key];
      output[key] = Array.isArray(value) ? [...value] : value;
    }
    for (const key of ['title', 'intro']) {
      const value = own(manual, key) ? manual[key] : proposal[key];
      if (typeof value === 'string') output[key] = value.trim();
    }
  } else {
    // Legacy automatic entries remain copy-only; old receipts retain their meaning.
    for (const key of ['title', 'intro']) {
      const value = typeof manual[key] === 'string' && manual[key].trim() ? manual[key] : proposal[key];
      if (typeof value === 'string') output[key] = value.trim();
    }
  }
  return output;
}

/** Match applyEdits key inference and ordered remove/re-add ownership. Invalid
 * journals remain diagnostics in the builder instead of crashing this projection.
 */
export function activityJournalFields(manual, journal, id, existsInitially = true) {
  let exists = existsInitially;
  let fields = exists ? { ...manual } : {};
  if (!Array.isArray(journal)) return fields;
  for (const edit of journal) {
    if (!edit || edit.kind !== 'activity') continue;
    const key = edit.key ?? edit.value?.id;
    if (typeof key !== 'string' || !key || key !== id) continue;
    if (edit.op === 'remove' && exists) { fields = {}; exists = false; }
    if (!edit.value || typeof edit.value !== 'object') continue;
    if (edit.op === 'add') { if (!exists) fields = {}; exists = true; Object.assign(fields, edit.value); }
    if (edit.op === 'patch' && exists) Object.assign(fields, edit.value);
  }
  return fields;
}
