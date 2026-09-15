/** Bundled iPhone panel transport. Credentials never enter JavaScript. */
export const nativePanel = typeof window !== "undefined" && location.protocol === "agent-panel:";
export async function panelFetch(path: string, init: RequestInit): Promise<Response> {
  if (!nativePanel) return fetch(path, init);
  const bridge = (window as any).webkit?.messageHandlers?.panel;
  if (!bridge) throw new Error("Подключите устройство в настройках приложения");
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let result;
  try { result = await bridge.postMessage({ path, method: init.method || "GET", body: init.body || null }); }
  catch (error) {
    if (init.method === "POST") throw new Error("Результат действия неизвестен. Обновите раздел и проверьте состояние перед повтором.");
    throw error;
  }
  // Preserve a completed response even if the UI timer fired meanwhile.
  // Dropping a successful POST here would invite duplicate side effects.
  return new Response(result.body, { status: result.status, headers: { "Content-Type": "application/json" } });
}
