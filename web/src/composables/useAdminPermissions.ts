import { computed, ref } from 'vue';
import { apiAdminRoleOptions } from '@/api/admin';
import { useUserStore } from '@/stores/user';
import type { Role, RoleOption, User } from '@/types';

/**
 * 管理端权限辅助（身份组等级 / 可赋予 / 可管理）。
 *
 * roleOptions 由后端 /admin/role-options 下发（避免前后端两套硬编码），
 * 这里作为模块级单例共享：用户管理 Tab 与用户对话框都依赖它，只需加载一次。
 */

/** 身份组下拉选项（由后端下发；assignable=当前登录者能否赋予该身份） */
const roleOptions = ref<RoleOption[]>([]);

/** 后端没拿到时的兜底等级表，仅用于按钮显隐，真正的校验始终在后端 */
const ROLE_LEVEL_FALLBACK: Record<string, number> = {
  user: 0, vip: 1, star: 1, operator: 1, senior_operator: 2, admin: 3, root: 4,
};

export function useAdminPermissions() {
  const store = useUserStore();

  function levelOfRole(role?: string): number {
    const hit = roleOptions.value.find((o) => o.value === role);
    return hit ? hit.level : (ROLE_LEVEL_FALLBACK[role ?? ''] ?? -1);
  }

  /** 当前登录者能否把别人设成该身份组（后端有同样的判断，前端只管按钮/下拉） */
  function isAssignable(role: Role): boolean {
    const hit = roleOptions.value.find((o) => o.value === role);
    if (hit) return hit.assignable;
    if (store.isRoot) return true;
    return levelOfRole(role) < levelOfRole(store.user?.role);
  }

  const roleAssignHint = computed(() =>
    store.isRoot
      ? '超级管理员可赋予任意身份组'
      : '管理员可赋予 普通用户 / 高级用户 / 明星 / 操作员 / 高级操作员（不能设为管理员或超级管理员）'
  );

  async function loadRoleOptions() {
    try {
      roleOptions.value = (await apiAdminRoleOptions()).list;
    } catch { /* 失败时用兜底等级表，接口权限仍由后端把关 */ }
  }

  /** 普通 admin 只能管理等级低于自己的账号（即不能动管理员/超级管理员）；root 无限制 */
  function canManageUser(row: User): boolean {
    if (store.isRoot) return true;
    return levelOfRole(row.role) < levelOfRole(store.user?.role);
  }

  return {
    roleOptions,
    levelOfRole,
    isAssignable,
    roleAssignHint,
    canManageUser,
    loadRoleOptions,
  };
}