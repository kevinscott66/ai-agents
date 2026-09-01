/**
 * Бейджи статусов: строка из БД → CSS-класс и подпись.
 *
 * Два повода собрать это в одном месте.
 *
 * Во-первых, `statusBadgeClass` для активностей была скопирована дословно в
 * `home/HomeActivities.tsx` и `sections/ActivitiesSection.tsx`. Правило тут
 * лингвистическое («не подтверждён» не должен читаться как «подтверждён»), и
 * расходящиеся копии означали бы, что на главной и в разделе один и тот же
 * гайд помечен по-разному.
 *
 * Во-вторых, класс собирался как `badge-${drop.status}`, где `status` —
 * свободный `TEXT` из БД. Preact экранирует значение, выхода из атрибута нет,
 * но пробел внутри значения даёт произвольный набор CSS-классов, а незнакомое
 * значение — класс, которого в стилях просто нет. Обе функции ниже возвращают
 * только имена из фиксированного списка.
 */

/**
 * Классы, которые описаны в styles.css. Ничего вне списка наружу не уходит.
 *
 * Именно `Map`, а не объектный литерал: у литерала `obj["__proto__"]` вернёт
 * `Object.prototype` вместо `undefined`, и `?? "badge-muted"` не сработает — в
 * `class` уехал бы результат приведения объекта к строке. Значение сюда идёт
 * из свободного `TEXT` в БД, так что это не гипотетика.
 */
const DROP_CLASS = new Map<string, string>([
  ["active", "badge-active"],
  ["soon", "badge-soon"],
  ["ended", "badge-ended"],
]);

const DROP_LABEL = new Map<string, string>([
  ["active", "Идёт"],
  ["soon", "Скоро"],
  ["ended", "Закончился"],
]);

/** Класс бейджа дропа. Незнакомый статус — нейтрально-серый. */
export function dropBadgeClass(status: string): string {
  return DROP_CLASS.get(status) ?? "badge-muted";
}

/**
 * Подпись бейджа дропа. Незнакомое значение показываем как есть: пустой бейдж
 * скрывает то, что в данных появился новый статус.
 */
export function dropBadgeLabel(status: string): string {
  return DROP_LABEL.get(status) ?? status;
}

/**
 * Класс бейджа статуса активности (RU-строки из ingest, свободный текст).
 * Незнакомые/пустые значения остаются нейтрально-серыми.
 */
export function activityBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("подтвержд") && !s.includes("не ")) return "badge-status-ok";
  if (s.includes("потенциал")) return "badge-status-soon";
  if (s.startsWith("не ") || s.includes("не подтвержд")) return "badge-status-no";
  return "badge-muted";
}
