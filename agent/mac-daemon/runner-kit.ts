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

/**
 * Окно, вставшее на капче, ждёт владельца: он проходит капчу руками в этом же
 * окне, а агент повторяет вызов. Столько браузер не закрывается по простою.
 */
export const CAPTCHA_HOLD_MS = 15 * 60_000;

/** Сколько ждать, пока зависший шаг сам упадёт после закрытия браузера. */
export const STUCK_GRACE_MS = 5_000;
/** Сколько после отмены/срока ждать, что шаг закончится сам, — до закрытия браузера. */
export const SELF_SETTLE_MS = 20_000;

/**
 * Не дать одному зависшему шагу навсегда занять исполнитель.
 *
 * Замок исполнителя (`busy`) снимается в `finally` у `run()`, а до него
 * доходит только завершённый шаг. Отмену мост присылает по своему таймауту,
 * но исполнитель видит её лишь между шагами: зависший `page.evaluate` или
 * навигация без таймаута не вернутся никогда. Так и было 2026-09-18 — браузера
 * уже нет, а на каждый запрос `shop_busy`, пока демон не перезапустили руками.
 *
 * Здесь работа гонится с отменой и жёстким сроком. Проиграла — сначала даём
 * ей `selfSettleMs` закончиться самой: живой, просто медленный шаг на отмене
 * сам уберёт за собой корзину, а закрытый браузер эту уборку оборвал бы. Не
 * закончилась — вызываем `release` (закрыть браузер: висящие вызовы Playwright
 * на закрытой странице падают сразу), даём до `graceMs` доупасть, чтобы
 * следующий запрос не наложился на хвост прошлого, и отдаём ошибку. `run()`
 * дальше снимет замок своим обычным `finally`.
 */
export async function settleOrRelease<T>(
  work: Promise<T>,
  o: { signal?: AbortSignal; deadlineMs: number; release: () => Promise<void>; graceMs?: number; selfSettleMs?: number },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stuck = new Promise<Error>((resolve) => {
    timer = setTimeout(() => resolve(new Error("runner_stuck")), o.deadlineMs);
    if (!o.signal) return;
    onAbort = () => resolve(new Error("assistant_cancelled"));
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  });
  // Исход работы запоминаем сразу: иначе её отказ после проигрыша гонки стал бы
  // необработанным отклонением промиса.
  const outcome = work.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const first = await Promise.race([outcome, stuck.then((cause) => ({ cause }))]);
    if ("value" in first) return first.value;
    if ("error" in first) throw first.error;
    const wait = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));
    const own = await Promise.race([outcome, wait(o.selfSettleMs ?? SELF_SETTLE_MS)]);
    if (own && "value" in own) return own.value;
    if (own) throw own.error;
    await o.release().catch(() => {});
    await Promise.race([outcome, wait(o.graceMs ?? STUCK_GRACE_MS)]);
    throw first.cause;
  } finally {
    clearTimeout(timer);
    if (onAbort) o.signal?.removeEventListener("abort", onAbort);
  }
}
