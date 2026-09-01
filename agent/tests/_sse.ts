/**
 * Хелпер для тестов SSE: вход в поток теперь по одноразовому билету, а не по
 * `?initData=` (аудит 2026-08-04, см. lib/sse-ticket.ts). Билет берётся тем же
 * путём, что и в браузере — POST /api/sse-ticket с initData в заголовке.
 */
export async function sseTicket(base: string, initData: string): Promise<string> {
  const r = await fetch(`${base}/api/sse-ticket`, {
    method: "POST",
    headers: { "X-Telegram-Init-Data": initData },
  });
  if (!r.ok) {
    throw new Error(`sse-ticket: HTTP ${r.status} ${await r.text()}`);
  }
  const body = (await r.json()) as { ticket: string };
  return body.ticket;
}

/** Готовый URL потока — замена `${base}/api/events?initData=...`. */
export async function sseUrl(base: string, initData: string): Promise<string> {
  const t = await sseTicket(base, initData);
  return `${base}/api/events?ticket=${encodeURIComponent(t)}`;
}
