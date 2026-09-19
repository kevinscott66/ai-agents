/**
 * Путь к помощнику EventKit — одно место на обоих вызывающих (macctl и assistant).
 *
 * Зовём не сам `agent-calendar`, а прокладку `agent-calendar-run` (calendar-spawn.c):
 * разрешение на Календарь TCC спрашивает у «ответственного» процесса, а им в демоне
 * становится bun — диалог не показывается, и календарь молча закрыт, сколько прав ни
 * выдавай самому помощнику. Прокладка снимает наследование, и решает запись помощника.
 *
 * MAC_CALENDAR_BIN_DIR — постоянная папка с обоими бинарями рядом, вне папки релиза.
 * Запись TCC привязана к пути и подписи бинаря, поэтому из релиза она терялась бы на
 * каждой выкатке. Без переменной остаётся путь внутри релиза, как было раньше.
 */
import { fileURLToPath } from "node:url";

const RUNNER = "agent-calendar-run";

export function calendarHelperPath(binDir?: string): string {
  const dir = binDir?.trim();
  if (!dir) return fileURLToPath(new URL(`./bin/${RUNNER}`, import.meta.url));
  if (!dir.startsWith("/")) throw new Error("calendar_bin_dir_invalid");
  return `${dir.replace(/\/+$/, "")}/${RUNNER}`;
}
