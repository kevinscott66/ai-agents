import { dirname, resolve } from "node:path";

/**
 * Где лежит native.db — состояние приложения на iPhone (устройства, диалоги,
 * вложения). Один разбор на писателя (`nativeAccess()`) и ночной бэкап: если
 * они разойдутся, бэкап будет честно снимать не тот файл.
 */
export function nativeStatePath(): string {
  return process.env.NATIVE_STATE_PATH || resolve(dirname(process.env.MEMORY_DB_PATH || "data/memory.db"), "native.db");
}
