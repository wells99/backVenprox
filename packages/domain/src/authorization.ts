export const permissions = ['users.manage','devices.manage','catalog.read','catalog.write','sales.read','sales.create',
  'cash.open','cash.close','cash.adjust','stock.adjust','sales.reverse','costs.read','settings.manage','credit.manage','recovery.manage'] as const;
export type Permission = typeof permissions[number];
export type Role = 'admin' | 'operator';
export const rolePermissions: Readonly<Record<Role, readonly Permission[]>> = {
  admin: permissions,
  operator: ['catalog.read','sales.read','sales.create','cash.open','cash.close'],
};
export interface AuthorizedContext {
  store_id: string; user_id: string; device_id: string | null; permissions: readonly Permission[];
  permissions_version: number; authorization_id: string; authorization_origin: 'online' | 'offline';
  authorized_at: string; expires_at: string;
}
export function permits(context: AuthorizedContext, permission: Permission): boolean { return context.permissions.includes(permission); }
