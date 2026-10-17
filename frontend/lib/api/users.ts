import {
  internalApiUrl,
  jsonInit,
  request,
  serverHeaders,
  type ApiResult,
  type UserStatus,
} from "./core";

export type PublicUser = {
  id: string;
  username: string;
  isRoot: boolean;
  status?: UserStatus;
  deletedAt?: string | null;
  roles: string[];
  createdAt: string;
};

export type RoleItem = {
  id: string;
  name: string;
  label: string;
  protected: boolean;
  permissions: string[];
};

export type PermissionItem = {
  id: string;
  name: string;
  label: string;
};

export type SessionInfo = {
  id: string;
  createdAt: string;
  expiresAt: string;
};

export type AuditEntry = {
  id: number;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AuditPage = {
  entries: AuditEntry[];
  nextCursor: string | null;
  hasMore: boolean;
};

export function browserCreateUser(input: {
  username: string;
  password: string;
}) {
  return request<{ user: PublicUser }>("/api/users", jsonInit("POST", input));
}

export function browserUpdateUsername(userId: string, username: string) {
  return request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}`,
    jsonInit("PATCH", { username }),
  );
}

export function browserResetPassword(userId: string, password: string) {
  return request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}/password`,
    jsonInit("PATCH", { password }),
  );
}

export function browserSetUserSuspended(userId: string, suspended: boolean) {
  return request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}/suspension`,
    jsonInit("PATCH", { suspended }),
  );
}

export function browserDeleteUser(userId: string) {
  return request<void>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export function browserRestoreUser(userId: string) {
  return request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}/restore`,
    { method: "POST" },
  );
}

export function browserListUserSessions(userId: string) {
  return request<{ sessions: SessionInfo[] }>(
    `/api/users/${encodeURIComponent(userId)}/sessions`,
    { method: "GET" },
  );
}

export function browserRevokeUserSession(userId: string, sessionId: string) {
  return request<void>(
    `/api/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function browserRevokeAllUserSessions(userId: string) {
  return request<void>(
    `/api/users/${encodeURIComponent(userId)}/sessions`,
    { method: "DELETE" },
  );
}

export function browserAssignUserRole(userId: string, roleId: string) {
  return request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    { method: "PUT" },
  );
}

export function browserRemoveUserRole(userId: string, roleId: string) {
  return request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    { method: "DELETE" },
  );
}

export function browserCreateRole(input: {
  name: string;
  label: string;
  permissions: string[];
}) {
  return request<{ role: RoleItem }>("/api/roles", jsonInit("POST", input));
}

export function browserUpdateRole(
  roleId: string,
  input: { name: string; label: string; permissions: string[] },
) {
  return request<{ role: RoleItem }>(
    `/api/roles/${encodeURIComponent(roleId)}`,
    jsonInit("PUT", input),
  );
}

export function browserDeleteRole(roleId: string) {
  return request<void>(`/api/roles/${encodeURIComponent(roleId)}`, {
    method: "DELETE",
  });
}

export function browserListAudit(params?: {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  cursor?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.actor) qs.set("actor", params.actor);
  if (params?.action) qs.set("action", params.action);
  if (params?.targetType) qs.set("targetType", params.targetType);
  if (params?.targetId) qs.set("targetId", params.targetId);
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return request<AuditPage>(`/api/audit${query ? `?${query}` : ""}`, {
    method: "GET",
  });
}

export async function serverListUsers(
  cookieHeader: string | undefined,
  options?: { includeDeleted?: boolean },
): Promise<ApiResult<{ users: PublicUser[] }>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  const qs = options?.includeDeleted ? "?includeDeleted=true" : "";
  return request<{ users: PublicUser[] }>(`${baseUrl}/api/users${qs}`, {
    headers: serverHeaders(cookieHeader),
  });
}

export async function serverListRoles(
  cookieHeader: string | undefined,
): Promise<ApiResult<{ roles: RoleItem[] }>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  return request<{ roles: RoleItem[] }>(`${baseUrl}/api/roles`, {
    headers: serverHeaders(cookieHeader),
  });
}

export async function serverListPermissions(
  cookieHeader: string | undefined,
): Promise<ApiResult<{ permissions: PermissionItem[] }>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  return request<{ permissions: PermissionItem[] }>(
    `${baseUrl}/api/permissions`,
    { headers: serverHeaders(cookieHeader) },
  );
}

export async function serverListAudit(
  cookieHeader: string | undefined,
  params?: {
    actor?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<ApiResult<AuditPage>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  const qs = new URLSearchParams();
  if (params?.actor) qs.set("actor", params.actor);
  if (params?.action) qs.set("action", params.action);
  if (params?.targetType) qs.set("targetType", params.targetType);
  if (params?.targetId) qs.set("targetId", params.targetId);
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return request<AuditPage>(`${baseUrl}/api/audit${query ? `?${query}` : ""}`, {
    headers: serverHeaders(cookieHeader),
  });
}
