// Telegram WebApp helper. Falls back to noop outside Telegram.
export function tg(): any {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

export interface TelegramLaunchState {
  inTelegram: boolean;
  hasInitData: boolean;
  userId: number | null;
}

/** Safe launch diagnostics; never return initData itself. */
export function telegramLaunchState(): TelegramLaunchState {
  try {
    const webApp = tg();
    const user = webApp?.initDataUnsafe?.user;
    return {
      inTelegram: Boolean(webApp),
      hasInitData: typeof webApp?.initData === "string" && webApp.initData.length > 0,
      userId: typeof user?.id === "number" ? user.id : null,
    };
  } catch {
    return { inTelegram: false, hasInitData: false, userId: null };
  }
}

export function haptic(kind: "success" | "warning" | "error" = "success") {
  try {
    tg()?.HapticFeedback?.notificationOccurred?.(kind);
  } catch {}
}

export function showAlert(msg: string) {
  const w = tg();
  if (w?.showAlert) w.showAlert(msg);
  else alert(msg);
}

export function isAdmin(): boolean {
  // Telegram init data does not contain a trusted admin claim. Authorization is
  // decided by the server; this client helper must stay conservative until the
  // server response is available.
  return false;
}

export function currentChatId(): number | null {
  try {
    const w = tg();
    const cid = w?.initDataUnsafe?.chat?.id;
    return typeof cid === "number" ? cid : null;
  } catch {
    return null;
  }
}

// Tiny toast system. Dispatches a CustomEvent that <ToastHost/> listens for.
export type ToastKind = "success" | "error" | "info";
export function toast(message: string, kind: ToastKind = "info", ttlMs = 1500) {
  try {
    window.dispatchEvent(
      new CustomEvent("miniapp-toast", { detail: { message, kind, ttlMs } }),
    );
  } catch {}
}
