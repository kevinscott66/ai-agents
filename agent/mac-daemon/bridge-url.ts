/**
 * Проверка адреса бриджа ПЕРЕД тем, как отдать в сокет `MAC_BRIDGE_SECRET`.
 *
 * Аудит 2026-08-13: демон открывал сокет на `MAC_BRIDGE_URL` и первым же
 * фреймом слал `{type:"auth", secret}` — кому угодно, кто ответил, по любой
 * схеме. Проверка на старте смотрела только, что переменная непустая, а секрет
 * длиной ≥32. То есть опечатка в хосте или `ws://` вместо `wss://` при выносе
 * бриджа за пределы машины отдавали 32-символьный ключ запуска `claude` с
 * доступом к MAC_PROJECT_ROOTS: открытым текстом в сеть, либо прямо в руки
 * чужому серверу. Секрет при этом уходит СРАЗУ при открытии сокета — до любого
 * обмена, то есть узнать «не тот сервер» можно только после утечки.
 *
 * Правило: `wss://` — можно куда угодно (TLS проверяет и канал, и хост).
 * `ws://` — только на петлю (127.0.0.0/8, ::1, localhost), где трафик машину не
 * покидает. Всё остальное — отказ на старте, до открытия сокета.
 *
 * Оговорка честно: на петле от локального процесса это не защищает. Кто успел
 * занять порт раньше бриджа, тот и получит фрейм. Но такой процесс уже идёт от
 * имени пользователя и может прочитать окружение демона напрямую — здесь эта
 * дыра не закрывается и закрываться не должна делать вид.
 *
 * Лазейка `MAC_BRIDGE_INSECURE_PLAINTEXT=1` — для случая, когда шифрует
 * транспорт под нами (SSH-туннель на не-петлевой адрес, Tailscale). Это
 * осознанное действие владельца, а не значение по умолчанию.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);

/** hostname из URL приходит без скобок для IPv6, но принимаем оба написания. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // Вся 127.0.0.0/8, а не только 127.0.0.1: 127.0.0.2 тоже никуда не уходит.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) && octetsInRange(h);
}

function octetsInRange(ip: string): boolean {
  return ip.split(".").every((o) => Number(o) <= 255);
}

/**
 * Возвращает текст отказа или `null`, если адресу можно доверить секрет.
 *
 * Чистая функция: флаг приходит аргументом, а не читается из окружения, —
 * иначе её нельзя проверить тестом, не пачкая process.env.
 */
export function bridgeSecretTransportError(
  raw: string,
  allowInsecurePlaintext = false,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `MAC_BRIDGE_URL is not a valid URL: ${raw}`;
  }
  if (url.protocol === "wss:") return null;
  if (url.protocol !== "ws:") {
    return `MAC_BRIDGE_URL must use ws:// or wss://, got ${url.protocol}//`;
  }
  if (isLoopbackHost(url.hostname)) return null;
  if (allowInsecurePlaintext) return null;
  return (
    `MAC_BRIDGE_URL is plaintext ws:// to a non-loopback host (${url.hostname}): ` +
    `MAC_BRIDGE_SECRET would be sent unencrypted over the network. ` +
    `Use wss://, or set MAC_BRIDGE_INSECURE_PLAINTEXT=1 if the transport is ` +
    `already encrypted (SSH tunnel, Tailscale).`
  );
}
