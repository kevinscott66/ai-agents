// SEC-7 / T-605: single source for the MTProto api_id/api_hash. Reads ONLY from
// env — no hardcoded fallback (the old `?? "<literal>"` defaults committed a
// real Telegram credential to source). Fails loudly when unset.

/** api_hash — md5-образный: ровно 32 шестнадцатеричных знака. */
const API_HASH_RE = /^[0-9a-f]{32}$/i;
/** Только десятичные цифры: без знака, точки, `0x` и `e`. */
const DECIMAL_RE = /^[0-9]+$/;
/**
 * `api_id` уезжает в TL-поле типа `int`, то есть знаковый 32-битный. Всё, что
 * больше, на проводе не представимо.
 */
const MAX_API_ID = 2_147_483_647;

export function requireTelegramApiCredentials(): { apiId: number; apiHash: string } {
  // Аудит 2026-08-28: значения брались из env как есть. EnvironmentFile= в
  // systemd и `.env` регулярно доносят хвостовой перевод строки или пробел, а
  // `"   "` вдобавок истинно — то есть проверка на пустоту его пропускала.
  // Пробел внутри credential наружу не виден: gramjs отдаёт его в MTProto, и
  // на выходе получается невнятный отказ авторизации вместо отказа на старте.
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  const apiIdRaw = process.env.TELEGRAM_API_ID?.trim();
  if (!apiHash || !apiIdRaw) {
    throw new Error(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in the environment " +
        "(no hardcoded fallback — see .env / .env.example).",
    );
  }
  // Форму хэша проверяем здесь, а не «где-нибудь потом»: другого места нет,
  // это единственная точка чтения. В сообщении — только длина: сам хэш это
  // секрет, и в лог он попасть не должен даже в тексте ошибки.
  if (!API_HASH_RE.test(apiHash)) {
    throw new Error(
      `TELEGRAM_API_HASH must be 32 hex characters (got ${apiHash.length} characters).`,
    );
  }
  // Аудит 2026-08-27: было `Number.isFinite`, и `TELEGRAM_API_ID="123.5"`
  // проезжало насквозь. MTProto api_id — целое; дробное уедет в Telegram и
  // вернётся невнятной ошибкой авторизации вместо отказа на старте.
  //
  // Аудит 2026-08-28: одного `Number.isInteger` мало, потому что `Number()`
  // принимает не только десятичную запись. `Number.isInteger(1e21)` истинно —
  // значит `TELEGRAM_API_ID=1e21` проходил проверку и уезжал числом, которого в
  // 32-битном поле не существует. `0x1E240` тем же путём молча становился
  // 123456: не отказ, а ЧУЖОЙ api_id, то есть попытка авторизоваться под
  // другим приложением. Поэтому запись проверяется до преобразования.
  if (!DECIMAL_RE.test(apiIdRaw)) {
    throw new Error("TELEGRAM_API_ID must be a positive integer in decimal notation.");
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0 || apiId > MAX_API_ID) {
    throw new Error(`TELEGRAM_API_ID must be a positive integer up to ${MAX_API_ID}.`);
  }
  return { apiId, apiHash };
}
