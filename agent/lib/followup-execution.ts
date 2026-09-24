import { AsyncLocalStorage } from 'node:async_hooks';
/** Internal execution context; never inferred from model text or task wording. */
type Execution = { chatId: number; userId: string; blocked?: string; created?: string[] };
export const followupExecution = new AsyncLocalStorage<Execution>();
export function blockFollowupDependency(chatId: number, userId: string, dependency: string): void {
 const execution = followupExecution.getStore();
 if (execution?.chatId === chatId && execution.userId === userId) execution.blocked = dependency;
}
export function blockedFollowupDependency(chatId: number, userId: string): string | undefined {
 const execution = followupExecution.getStore();
 return execution?.chatId === chatId && execution.userId === userId ? execution.blocked : undefined;
}
