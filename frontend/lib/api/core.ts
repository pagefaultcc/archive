export type UserStatus = "active" | "suspended";

export type ApiErrorCode =
  | "invalid_request"
  | "invalid_credentials"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "body_too_large"
  | "unsupported_media_type"
  | "username_taken"
  | "role_conflict"
  | "immutable_target"
  | "invalid_archive_format"
  | "invalid_archive_password"
  | "corrupt_archive"
  | "authentication_busy"
  | "service_unavailable"
  | "internal_error";

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  fields?: Record<string, string>;
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiError | null; networkError?: boolean };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;
  readonly fields: Record<string, string> | null;

  constructor(status: number, error: ApiError | null) {
    super(error?.message ?? "Request failed.");
    this.name = "ApiRequestError";
    this.status = status;
    this.code = error?.code ?? null;
    this.fields = error?.fields ?? null;
  }
}

export const SESSION_COOKIE = "archive_session";

export function parseErrorEnvelope(body: unknown): ApiError | null {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const error = body.error;
  if (typeof error !== "object" || error === null) return null;
  if (!("code" in error) || !("message" in error)) return null;
  const { code, message } = error;
  if (typeof code !== "string" || typeof message !== "string") return null;
  const fields =
    "fields" in error &&
    typeof error.fields === "object" &&
    error.fields !== null
      ? (error.fields as Record<string, string>)
      : undefined;
  return { code: code as ApiErrorCode, message, fields };
}

export async function request<T>(
  path: string,
  init: RequestInit,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store" });
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }

  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: parseErrorEnvelope(body),
    };
  }
  return { ok: true, data: body as T };
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function internalApiUrl(): string {
  const url = process.env.INTERNAL_API_URL;
  if (!url) {
    throw new Error("INTERNAL_API_URL is not configured.");
  }
  return url;
}

export function serverHeaders(cookieHeader: string | undefined): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  const match = cookieHeader?.match(/(?:^|;\s*)archive_session=([^;]*)/);
  if (match) {
    headers.Cookie = `${SESSION_COOKIE}=${match[1]}`;
  }
  return headers;
}
