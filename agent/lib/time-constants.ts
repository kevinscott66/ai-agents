/**
 * Time constants in milliseconds.
 *
 * Use these instead of inline `24 * 60 * 60 * 1000` arithmetic to keep
 * intent obvious and avoid duplicate magic numbers across the codebase.
 *
 * Background: T-321 audit found `24 * 60 * 60 * 1000` in 5 files,
 * `60 * 60 * 1000` in 3+, `5 * 60 * 1000` in 3+. Consolidated here.
 *
 * Аудит 2026-08-28: «Consolidated here» было обещанием, а не фактом — в
 * рабочем коде оставалось 17 таких выражений (lib/backup.ts, lib/fix-chain.ts,
 * lib/site-ingest.ts, lib/cold-storage.ts, tools/weekly-draft.ts и другие), а
 * импортировали этот файл шесть модулей. Разнесены; чтобы строка снова не
 * стала неправдой, её держит `tests/audit-2026-08-28-docblock-promises.test.ts`
 * — обход дерева, запрещающий инлайновую арифметику миллисекунд в lib/,
 * orchestrator/, tools/ и characters/. В тестах она разрешена: там число на
 * месте читается лучше константы.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
