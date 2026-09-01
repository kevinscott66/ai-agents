/** Lead-bot entry point for the Telegram Mini App panel. */

export const MINIAPP_MENU_BUTTON_TEXT = "Панель";
export const DEFAULT_MINIAPP_PUBLIC_URL = "https://agents.example.com:8443";

export interface MiniAppMenuClient {
  telegram: {
    setChatMenuButton(input: {
      menuButton: {
        type: "web_app";
        text: string;
        web_app: { url: string };
      };
    }): Promise<unknown>;
  };
}

export type MiniAppUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: "missing_url" | "invalid_url" };

/** Only accept an HTTPS origin that Telegram can open as a Web App. */
export function resolveMiniAppPublicUrl(
  raw = process.env.MINIAPP_PUBLIC_URL || DEFAULT_MINIAPP_PUBLIC_URL,
): MiniAppUrlResult {
  if (!raw?.trim()) return { ok: false, reason: "missing_url" };

  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return { ok: false, reason: "invalid_url" };
    }
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

export async function configureMiniAppMenuButton(
  bot: MiniAppMenuClient,
  // Аудит 2026-08-27: было `rawUrl = process.env.MINIAPP_PUBLIC_URL`, и
  // фолбэк на DEFAULT_MINIAPP_PUBLIC_URL внутри resolveMiniAppPublicUrl не
  // срабатывал НИКОГДА: дефолт параметра подставляется только вместо
  // undefined, а пустая строка передаётся как значение. `.env.example`
  // отгружает MINIAPP_PUBLIC_URL пустым, так что на свежей машине кнопка
  // «Панель» не ставилась вовсе — с ответом missing_url вместо адреса,
  // который у проекта на самом деле есть.
  rawUrl = process.env.MINIAPP_PUBLIC_URL || DEFAULT_MINIAPP_PUBLIC_URL,
): Promise<MiniAppUrlResult> {
  const resolved = resolveMiniAppPublicUrl(rawUrl);
  if (!resolved.ok) return resolved;

  await bot.telegram.setChatMenuButton({
    menuButton: {
      type: "web_app",
      text: MINIAPP_MENU_BUTTON_TEXT,
      web_app: { url: resolved.url },
    },
  });
  return resolved;
}
