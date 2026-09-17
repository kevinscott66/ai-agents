/**
 * Общее у исполнителей Яндекса на Mac (такси, покупки, доставка): проверка
 * каталога профиля, код ошибки для демона и мелочи CLI владельца.
 *
 * Сами исполнители (операции, сессии, скриншоты) остаются в модулях сервисов:
 * их шаги и отказы разные.
 */
import { isAbsolute } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";

export type ProfileProblem = "profile_missing" | "profile_insecure";

/**
 * Профиль с cookie Яндекса — это доступ к привязанной карте. Только
 * абсолютный путь, каталог текущего пользователя и никаких прав для группы
 * и остальных. null — каталог годится.
 */
export function profileDirProblem(dir: string | undefined, uid: number | undefined): ProfileProblem | null {
  if (!dir || !isAbsolute(dir)) return "profile_missing";
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return "profile_missing";
  }
  if (!st.isDirectory()) return "profile_missing";
  if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) return "profile_insecure";
  return null;
}

/** Ошибка кадра → код для сервера: неверный запрос, отмена ассистентом или общий сбой сервиса. */
export function runnerErrorCode(error: unknown, invalidCode: string, failedCode: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === invalidCode) return message;
  if (message === "assistant_cancelled" || (error instanceof Error && error.name === "AbortError")) return "assistant_cancelled";
  return failedCode;
}

/** `login` создаёт каталог профиля сам (0700); `probe` — только существующий. */
export function ensureLoginProfileDir(command: string, dir: string | undefined): void {
  if (command === "login" && dir && isAbsolute(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Ждать, пока владелец нажмёт Enter в терминале. */
export function waitForEnter(): Promise<void> {
  return new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
}

/** Ответ исполнителя в терминал: скриншот отказа — только его размер. */
export function printOutcome(out: { ok: boolean; screenshot?: string }): void {
  console.log(JSON.stringify(out.ok ? out : { ...out, screenshot: out.screenshot ? `<${out.screenshot.length} base64>` : undefined }, null, 2));
}

/** Запуск CLI: выход 0 или код известного отказа (иначе текст ошибки) и выход 1. */
export function runCli(main: () => Promise<void>, knownCode: (e: unknown) => string | null): void {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(knownCode(e) ?? (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
