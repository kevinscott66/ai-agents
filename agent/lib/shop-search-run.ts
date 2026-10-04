/** Stop retrying an unreadable catalogue within one trusted request, across runtimes. */
const blocked = new Map<string, number>();
const TTL = 15 * 60_000;
type Context = { requestId?: string; agentKey: string; chatId: number; triggerUserId?: string };
const key = (ctx: Context) => ctx.requestId ? JSON.stringify([ctx.requestId, ctx.agentKey, ctx.chatId, ctx.triggerUserId]) : null;
export function shopSearchRunBlocked(ctx: Context, now = Date.now()): boolean {
  for (const [id, expires] of blocked) if (expires <= now) blocked.delete(id);
  const id = key(ctx);
  return id !== null && blocked.has(id);
}
export function noteIncompleteShopSearch(ctx: Context, now = Date.now()): void {
  shopSearchRunBlocked(ctx, now);
  const id = key(ctx);
  if (!id) return;
  if (blocked.size >= 512) blocked.delete(blocked.keys().next().value!);
  blocked.set(id, now + TTL);
}
