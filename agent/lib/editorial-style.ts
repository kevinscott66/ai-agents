/** Publication quality, not AI authorship detection. See docs/product/editorial-style.md. */
export const EDITORIAL_STYLE_GUIDE = [
  'Пиши о действии, условиях и результате; каждый абзац добавляет проверяемую информацию.',
  'Убери рекламные превосходные степени, пустую значимость, отвлечённые выводы о будущем и повтор лида другими словами.',
  'Мнение приписывай названному человеку или организации с источником; безымянные эксперты не подтверждают вывод.',
  'Не подменяй доказательства перечислением авторитетных изданий. Ссылка должна подтверждать именно соседнее утверждение.',
  'Не придумывай личный опыт, цитаты, связь событий и причинность. Не заполняй объём общими словами.',
  'Удаляй обращения к заказчику, остатки промпта, незаполненные шаблоны и внутренние метки цитирования.',
  'Не маскируй шаблон синонимами, нарочитыми ошибками или случайной пунктуацией. Сохраняй названия, суммы, даты и ограничения.',
  'Не запрещай обычные слова, тире или цитаты сами по себе. Фирменные эмодзи и короткие жирные акценты допустимы; не выделяй весь абзац.',
].join(' ');

export interface EditorialCopy { title?: string; summary?: string; body?: string; intro?: string; }
export interface StyleFinding {
  code: string;
  severity: 'block' | 'warn';
  field: keyof EditorialCopy;
  message: string;
}

/** Quoted examples and code can legitimately discuss bad writing. Never rewrite copy. */
function prose(value: string): string {
  return value.normalize('NFKC')
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
    .replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, ' ');
}

const residue: [string, RegExp, string][] = [
  ['canned-filler', /играет важную роль|(?:важно|необходимо|стоит) отметить|в современном мире|в эпоху цифровизации|не секрет, что|динамично развивается|откройте для себя|в заключение|давайте разбер[её]мся/iu, 'замени шаблонную подводку конкретным фактом или удали её'],
  ['assistant-voice', /(?:как (?:языковая модель|ИИ[- ]ассистент)|as an AI (?:language model|assistant)|вот (?:готовый|исправленный|переписанный) (?:текст|вариант)|надеюсь, (?:это|этот ответ) (?:поможет|помог)|если хотите, я могу)/iu, 'в тексте остался ответ ассистента заказчику'],
  ['template-placeholder', /\[(?:вставьте|укажите|добавьте|insert|add here|your (?:text|source|title))[^\]\n]*\]|\{\{(?:название проекта|источник|insert[^}]*|project_name)\}\}/iu, 'остался незаполненный шаблон'],
  ['internal-citation', /(?:cite|turn|contentReference\[oaicite|\[?turn\d+(?:search|view|news)\d+\]?)/u, 'осталась внутренняя метка цитирования'],
];

export function editorialStyleFindings(copy: EditorialCopy): StyleFinding[] {
  const findings: StyleFinding[] = [];
  for (const field of ['title', 'summary', 'body', 'intro'] as const) {
    const original = copy[field];
    if (typeof original !== 'string' || !original.trim()) continue;
    const text = prose(original);
    for (const [code, pattern, message] of residue) {
      if (pattern.test(text)) findings.push({code, severity: 'block', field, message});
    }
    if (/(?:эксперты|аналитики|наблюдатели)\s+(?:считают|полагают|отмечают|уверены)|по мнению экспертов/iu.test(text))
      findings.push({code: 'vague-attribution', severity: 'warn', field, message: 'назови автора мнения и его источник либо убери вывод'});
    if (/открывает новую (?:эру|эпоху)|меняет правила игры|знаменует собой|подч[её]ркивает (?:важность|значимость)|отражает более широкую тенденцию/iu.test(text))
      findings.push({code: 'empty-significance', severity: 'warn', field, message: 'проверь, добавляет ли оценка конкретный подтверждённый факт'});
    const bold = [...original.matchAll(/\*\*([^*]+)\*\*/g)];
    if (bold.length >= 3 && bold.reduce((n, m) => n + m[1].length, 0) > original.replace(/\*/g, '').length * .6)
      findings.push({code: 'overemphasis', severity: 'warn', field, message: 'сократи жирное выделение до ключевых фактов'});
  }
  const lead = prose(copy.summary ?? '').replace(/\*/g, '').trim();
  const body = prose(copy.body ?? '').replace(/\*/g, '');
  if (lead.length >= 80 && body.includes(lead))
    findings.push({code: 'repeated-lead', severity: 'warn', field: 'body', message: 'тело повторяет лид дословно; добавь факты вместо повтора'});
  return findings;
}

/** Only objective publication residue blocks a draft; contextual warnings are not proof. */
export function editorialStyleErrors(copy: EditorialCopy): string[] {
  return editorialStyleFindings(copy).filter(f => f.severity === 'block').map(f => `${f.field}: ${f.message}`);
}
