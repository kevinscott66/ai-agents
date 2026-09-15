import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'bun:sqlite';
// Trusted ingress context, never model-supplied payload fields.
export const nativeTurnContext = new AsyncLocalStorage<{ userId: string; turnId:string; conversationId:string; linkApproval: (id:string) => void }>();
export function persistNativeApprovalLink(database: Database, approvalId:string, chatId:number) {
  const context = nativeTurnContext.getStore();
  if (!context || context.userId !== String(chatId)) return;
  // Executed inside the same transaction as approval creation.
  database.run('CREATE TABLE IF NOT EXISTS native_approval_links(approval_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,turn_id TEXT NOT NULL,conversation_id TEXT NOT NULL,execution TEXT,output TEXT)');
  database.query('INSERT INTO native_approval_links(approval_id,user_id,turn_id,conversation_id) VALUES(?,?,?,?)').run(approvalId,context.userId,context.turnId,context.conversationId);
}
export function nativeApprovalLinks(database: Database, userId:string, conversationId?:string) {
  if (!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_approval_links'").get()) return [];
  return database.query('SELECT approval_id,turn_id,conversation_id,execution,output FROM native_approval_links WHERE user_id=?' + (conversationId ? ' AND conversation_id=?' : '')).all(...(conversationId ? [userId,conversationId] : [userId])) as {approval_id:string;turn_id:string;conversation_id:string;execution:string|null;output:string|null}[];
}
