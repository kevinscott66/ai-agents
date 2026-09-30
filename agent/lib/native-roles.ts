/** Optional office ingress reuses the paired native owner boundary and role handlers. */
import { CHARACTERS, type RoleKey } from '../characters/index.ts';
import type { NativeLead } from './native-api.ts';
const runners = new Map<RoleKey, NativeLead>();
export const officeRoles = CHARACTERS.map(({key, name})=>({key,name}));
export function isOfficeRole(value: unknown): value is RoleKey {
  return typeof value === 'string' && officeRoles.some(role=>role.key===value);
}
export function configureNativeRole(role:RoleKey, run:NativeLead) {
  const previous=runners.get(role);runners.set(role,run);
  return ()=>{if(previous)runners.set(role,previous);else runners.delete(role);};
}
export function nativeRole(role:RoleKey) { return runners.get(role); }
