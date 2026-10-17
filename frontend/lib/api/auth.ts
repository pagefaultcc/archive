import { internalApiUrl, jsonInit, request, serverHeaders, type UserStatus } from "./core";

export type SessionUser = {
  id: string;
  username: string;
  isRoot: boolean;
  status?: UserStatus;
  roles: string[];
  permissions: string[];
};

export function browserLogin(input: { username: string; password: string }) {
  return request<{ user: SessionUser }>(
    "/api/auth/login",
    jsonInit("POST", input),
  );
}

export function browserLogout() {
  return request<void>("/api/auth/logout", { method: "POST" });
}

export function browserChangePassword(input: { currentPassword: string; newPassword: string }) {
  return request<{ status: string; message: string }>(
    "/api/auth/change-password",
    jsonInit("POST", input)
  );
}

export async function serverGetMe(cookieHeader: string | undefined) {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true } as const;
  }
  return request<{ user: SessionUser }>(`${baseUrl}/api/auth/me`, {
    headers: serverHeaders(cookieHeader),
  });
}
