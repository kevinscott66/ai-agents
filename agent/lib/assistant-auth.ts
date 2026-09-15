import { isUserAllowed } from './mac-bridge.ts';
import { isAllowlisted } from './allowlist.ts';
/** Personal device access and proactive delivery share the same live owner ACL. */
export function isAssistantOwner(userId: string): boolean {
  const chats = (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return isUserAllowed(userId) && isAllowlisted(userId, chats);
}
