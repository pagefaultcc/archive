/**
 * Sole typed adapter for the backend JSON envelopes.
 *
 * Browser mutations call relative `/api/*` (proxied to the API by a Next.js
 * rewrite). Server Components call `${INTERNAL_API_URL}/api/*` directly and
 * forward only the incoming `archive_session` cookie.
 */

export type UserStatus = "active" | "suspended";

export type SessionUser = {
  id: string;
  username: string;
  isRoot: boolean;
  status?: UserStatus;
  roles: string[];
  permissions: string[];
};

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
export type ArchiveFormat = "zip" | "7z" | "rar";

export type ArchiveStatus = "indexed" | "password_required" | "failed";

export type ArchiveItem = {
  id: string;
  ownerId: string;
  ownerUsername: string;
  filename: string;
  format: ArchiveFormat;
  sizeBytes: number;
  sha256: string;
  isEncrypted: boolean;
  status: ArchiveStatus;
  fileCount: number;
  dirCount: number;
  uncompressedBytes: number;
  createdAt: string;
};

export type ArchiveEntry = {
  id: number;
  path: string;
  parentPath: string;
  name: string;
  isDir: boolean;
  sizeBytes: number;
  packedBytes: number;
  crc32: string;
  encrypted: boolean;
  modifiedAt: string | null;
};

export type ArchiveDetail = {
  archive: ArchiveItem;
  entries: ArchiveEntry[];
  parentPath: string;
  query: string;
};

export type ArchiveFilePreview = {
  entry: ArchiveEntry;
  kind: "text" | "image" | "binary";
  mimeType: string;
  text?: string;
  base64Data?: string;
  hexPreview?: string;
  truncated: boolean;
};
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

export type StorageTypeStat = {
  extension: string;
  count: number;
  sizeBytes: number;
};

export type StorageFormatStat = {
  format: string;
  count: number;
  sizeBytes: number;
};

export type ArchiveSizeBreakdown = {
  id: string;
  filename: string;
  format: string;
  packedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  dirCount: number;
  ratio: string;
};

export type GlobalStorageStats = {
  totalArchives: number;
  totalPackedBytes: number;
  totalUncompressedBytes: number;
  totalFiles: number;
  totalDirs: number;
  encryptedVaults: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
  formatDistribution: StorageFormatStat[];
  archiveBreakdown: ArchiveSizeBreakdown[];
};
export type CookieDomainSummary = {
  domain: string;
  logCount: number;
  totalCookies: number;
};

export type CookieDomainLogItem = {
  id: number;
  archiveId: string;
  archiveFilename: string;
  entryPath: string;
  entryName: string;
  domain: string;
  cookieCount: number;
  netscapeText: string;
  jsonText: string;
};

export type CookieDomainsListResponse = {
  domains: CookieDomainSummary[];
  totalDomains: number;
  totalLogs: number;
  totalCookies: number;
};

export type CookieDomainLogsResponse = {
  domain: string;
  logs: CookieDomainLogItem[];
};

export type ArchiveSearchResult = {
  id: number;
  archiveId: string;
  archiveFilename: string;
  path: string;
  name: string;
  sizeBytes: number;
  packedBytes: number;
  crc32: string;
  encrypted: boolean;
  modifiedAt: string | null;
};

export type SearchParams = {
  q?: string;
  name?: string;
  type?: string;
  minSize?: number;
  maxSize?: number;
  archive?: string;
  regex?: boolean;
  exact?: boolean;
  limit?: number;
  offset?: number;
};

export type SearchResponse = {
  results: ArchiveSearchResult[];
  totalCount: number;
  limit: number;
  offset: number;
};

export type SearchDownloadJob = {
  id: string;
  status: "preparing" | "ready" | "error";
  total: number;
  processed: number;
  percent: number;
  zipName: string;
  downloadUrl?: string;
  error?: string;
};

export type TelegramChannelItem = {
  id: string;
  name: string;
  channelId: string;
  passwordScript: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramSettings = {
  apiId: number;
  apiHash: string;
  sessionString: string;
  isConfigured: boolean;
};

export type ScrapedMessageItem = {
  messageId: number;
  date: string;
  filename: string;
  sizeBytes: number;
  caption: string;
  resolvedPassword: string;
  alreadyArchived?: boolean;
  blacklisted?: boolean;
  blacklistReason?: string;
};

const SESSION_COOKIE = "archive_session";

function parseErrorEnvelope(body: unknown): ApiError | null {
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

async function request<T>(
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

// ---------------------------------------------------------------------------
// Browser transport: relative URLs so the Next.js rewrite proxies to the API.
// ---------------------------------------------------------------------------

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function browserLogin(input: { username: string; password: string }) {
  return request<{ user: SessionUser }>(
    "/api/auth/login",
    jsonInit("POST", input),
  );
}

export function browserLogout() {
  return request<void>("/api/auth/logout", { method: "POST" });
}

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

export function browserListArchives() {
  return request<{ archives: ArchiveItem[] }>("/api/archives", {
    method: "GET",
  });
}

export function browserGetArchive(
  archiveId: string,
  params?: { parent?: string; q?: string },
) {
  const qs = new URLSearchParams();
  if (params?.parent !== undefined) qs.set("parent", params.parent);
  if (params?.q) qs.set("q", params.q);
  const query = qs.toString();
  return request<ArchiveDetail>(
    `/api/archives/${encodeURIComponent(archiveId)}${query ? `?${query}` : ""}`,
    { method: "GET" },
  );
}

export function browserPreviewArchiveFile(archiveId: string, path: string) {
  const qs = new URLSearchParams({ path });
  return request<ArchiveFilePreview>(
    `/api/archives/${encodeURIComponent(archiveId)}/file?${qs.toString()}`,
    { method: "GET" },
  );
}

export function archiveDownloadUrl(
  archiveId: string,
  path: string,
  asZip = false,
): string {
  const qs = new URLSearchParams({ path });
  if (asZip) qs.set("zip", "1");
  return `/api/archives/${encodeURIComponent(archiveId)}/download?${qs.toString()}`;
}

export function browserUnlockArchive(archiveId: string, password: string) {
  return request<{ archive: ArchiveItem }>(
    `/api/archives/${encodeURIComponent(archiveId)}/unlock`,
    jsonInit("POST", { password }),
  );
}

export function browserDeleteArchive(archiveId: string) {
  return request<void>(`/api/archives/${encodeURIComponent(archiveId)}`, {
    method: "DELETE",
  });
}

export function browserReindexAllArchives() {
  return request<{ reindexed: number; total: number; errors: string[] }>(
    "/api/archives/reindex",
    { method: "POST" },
  );
}

export function browserReindexArchive(archiveId: string) {
  return request<{ archive: ArchiveItem }>(
    `/api/archives/${encodeURIComponent(archiveId)}/reindex`,
    { method: "POST" },
  );
}

export function browserGetStorageStats() {
  return request<GlobalStorageStats>("/api/settings/storage", {
    method: "GET",
  });
}

export function browserListCookieDomains(q?: string) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<CookieDomainsListResponse>(`/api/cookies${qs}`, {
    method: "GET",
  });
}

export function browserListCookieDomainLogs(domain: string, q?: string) {
  const params = new URLSearchParams({ domain });
  if (q && q.trim()) params.set("q", q.trim());
  return request<CookieDomainLogsResponse>(`/api/cookies?${params.toString()}`, {
    method: "GET",
  });
}

export function cookieBulkDownloadUrl(
  domain: string,
  count?: number,
  format: "netscape" | "json" = "netscape",
): string {
  const params = new URLSearchParams({ domain, format });
  if (count && count > 0) params.set("count", String(count));
  return `/api/cookies/download?${params.toString()}`;
}

export function browserSearchArchiveEntries(params: SearchParams) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.name) sp.set("name", params.name);
  if (params.type) sp.set("type", params.type);
  if (params.archive) sp.set("archive", params.archive);
  if (params.regex) sp.set("regex", "1");
  if (params.exact) sp.set("exact", "1");
  if (params.minSize !== undefined && params.minSize > 0)
    sp.set("minSize", String(params.minSize));
  if (params.maxSize !== undefined && params.maxSize > 0)
    sp.set("maxSize", String(params.maxSize));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset !== undefined) sp.set("offset", String(params.offset));
  return request<SearchResponse>(`/api/search?${sp.toString()}`, {
    method: "GET",
  });
}

export function searchBulkDownloadUrl(params: SearchParams): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.name) sp.set("name", params.name);
  if (params.type) sp.set("type", params.type);
  if (params.archive) sp.set("archive", params.archive);
  if (params.regex) sp.set("regex", "1");
  if (params.exact) sp.set("exact", "1");
  if (params.minSize !== undefined && params.minSize > 0)
    sp.set("minSize", String(params.minSize));
  if (params.maxSize !== undefined && params.maxSize > 0)
    sp.set("maxSize", String(params.maxSize));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  return `/api/search/download?${sp.toString()}`;
}

export function browserCleanupTempFiles() {
  return request<{ freedBytes: number; removedCount: number }>(
    "/api/settings/cleanup-temp",
    { method: "POST" },
  );
}

export function browserGetArchivePasswords() {
  return request<{ passwords: string[] }>("/api/settings/passwords", {
    method: "GET",
  });
}

export function browserUpdateArchivePasswords(passwords: string[]) {
  return request<{ passwords: string[] }>(
    "/api/settings/passwords",
    jsonInit("PUT", { passwords }),
  );
}

export function browserPrepareSearchDownload(params: SearchParams) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.name) sp.set("name", params.name);
  if (params.type) sp.set("type", params.type);
  if (params.archive) sp.set("archive", params.archive);
  if (params.regex) sp.set("regex", "1");
  if (params.exact) sp.set("exact", "1");
  if (params.minSize !== undefined && params.minSize > 0)
    sp.set("minSize", String(params.minSize));
  if (params.maxSize !== undefined && params.maxSize > 0)
    sp.set("maxSize", String(params.maxSize));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  return request<{ jobId: string; total: number }>(
    `/api/search/prepare-download?${sp.toString()}`,
    { method: "POST" },
  );
}

export function browserGetSearchDownloadJob(jobId: string) {
  return request<SearchDownloadJob>(
    `/api/search/download-job/${encodeURIComponent(jobId)}`,
    { method: "GET" },
  );
}

export function browserGetChannelSettings() {
  return request<{ settings: TelegramSettings }>("/api/channels/settings", {
    method: "GET",
  });
}

export function browserUpdateChannelSettings(input: {
  apiId: number;
  apiHash: string;
  sessionString: string;
}) {
  return request<{ settings: TelegramSettings }>(
    "/api/channels/settings",
    jsonInit("PUT", input),
  );
}

export function browserTestChannelConnection() {
  return request<{
    status: string;
    user?: { id: number; username: string; firstName: string; phone: string };
    message?: string;
  }>("/api/channels/test-connection", { method: "POST" });
}

export function browserListChannels() {
  return request<{ channels: TelegramChannelItem[] }>("/api/channels", {
    method: "GET",
  });
}

export function browserCreateChannel(input: {
  name: string;
  channelId: string;
  passwordScript: string;
}) {
  return request<{ channel: TelegramChannelItem }>(
    "/api/channels",
    jsonInit("POST", input),
  );
}

export function browserUpdateChannel(
  id: string,
  input: { name: string; channelId: string; passwordScript: string },
) {
  return request<{ channel: TelegramChannelItem }>(
    `/api/channels/${encodeURIComponent(id)}`,
    jsonInit("PUT", input),
  );
}

export function browserDeleteChannel(id: string) {
  return request<void>(`/api/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function browserTestPasswordScript(input: {
  script: string;
  messageContent: string;
}) {
  return request<{ status: string; resolvedPassword: string; message?: string }>(
    "/api/channels/test-script",
    jsonInit("POST", input),
  );
}

export function browserScrapeChannel(input: {
  channelId: string;
  limit: number;
}) {
  return request<{
    status: string;
    items?: ScrapedMessageItem[];
    message?: string;
  }>("/api/channels/scrape", jsonInit("POST", input));
}

export function browserImportScrapedFiles(input: {
  channelId: string;
  items: Array<{ messageId: number; filename: string; sizeBytes?: number; password: string }>;
}) {
  return request<{
    imported: number;
    failed: number;
    results: Array<{
      filename: string;
      status: string;
      id?: string;
      error?: string;
    }>;
  }>("/api/channels/import", jsonInit("POST", input));
}

export function browserClearChannelBlacklist(channelId?: string) {
  const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
  return request<{ status: string; cleared: boolean }>(`/api/channels/blacklist${q}`, {
    method: "DELETE",
  });
}

export type TelegramImportJob = {
  id: string;
  channelId: string;
  messageId: number;
  filename: string;
  stage: "queued" | "downloading" | "indexing" | "done" | "skipped" | "error";
  statusText: string;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  speedMbps: number;
  etaSeconds: number;
  archiveId?: string;
  error?: string;
  createdAt: string;
};

export function browserCreateTelegramImportJob(input: {
  channelId: string;
  messageId: number;
  filename: string;
  password?: string;
}) {
  return request<{ job: TelegramImportJob }>("/api/channels/import-job", jsonInit("POST", input));
}

export function browserGetTelegramImportJob(jobId: string) {
  return request<{ job: TelegramImportJob }>(
    `/api/channels/import-job/${encodeURIComponent(jobId)}`,
    { method: "GET" },
  );
}

export type TelegramQueueStatus = {
  active: TelegramImportJob | null;
  activeList?: TelegramImportJob[];
  totalSpeedMbps?: number;
  pendingCount: number;
  pending: TelegramImportJob[];
  completed: TelegramImportJob[];
};

export function browserEnqueueTelegramBatch(input: {
  channelId: string;
  items: Array<{ messageId: number; filename: string; sizeBytes?: number; password?: string }>;
}) {
  return request<{ status: string; queuedCount: number; skippedCount: number }>(
    "/api/channels/queue",
    jsonInit("POST", input),
  );
}

export function browserGetTelegramQueue() {
  return request<TelegramQueueStatus>("/api/channels/queue", { method: "GET" });
}

export function browserClearTelegramQueue() {
  return request<{ status: string; cleared: boolean }>("/api/channels/queue", { method: "DELETE" });
}

export function browserUploadArchiveWithProgress(input: {
  file: File;
  password?: string;
  onProgress?: (progress: {
    loaded: number;
    total: number;
    percent: number;
    stage: "uploading" | "indexing";
  }) => void;
}): Promise<
  ApiResult<{ archive: ArchiveItem; passwordRequired?: boolean; autoUnlocked?: boolean }>
> {
  const { promise, resolve } =
    Promise.withResolvers<
      ApiResult<{ archive: ArchiveItem; passwordRequired?: boolean; autoUnlocked?: boolean }>
    >();
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/archives", true);

  xhr.upload.onprogress = (event) => {
    if (!input.onProgress) return;
    const total =
      event.lengthComputable && event.total > 0
        ? event.total
        : input.file.size || 1;
    const loaded = Math.min(event.loaded, total);
    const percent = Math.min(95, Math.round((loaded / total) * 95));
    input.onProgress({
      loaded,
      total,
      percent,
      stage: loaded >= total ? "indexing" : "uploading",
    });
  };

  xhr.upload.onload = () => {
    input.onProgress?.({
      loaded: input.file.size,
      total: input.file.size || 1,
      percent: 96,
      stage: "indexing",
    });
  };

  xhr.onerror = () => {
    resolve({ ok: false, status: 0, error: null, networkError: true });
  };

  xhr.onload = () => {
    let body: unknown = null;
    try {
      body = JSON.parse(xhr.responseText);
    } catch {
      body = null;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      input.onProgress?.({
        loaded: input.file.size,
        total: input.file.size || 1,
        percent: 100,
        stage: "indexing",
      });
      resolve({
        ok: true,
        data: body as { archive: ArchiveItem; passwordRequired?: boolean },
      });
      return;
    }
    resolve({
      ok: false,
      status: xhr.status,
      error: parseErrorEnvelope(body),
    });
  };

  const formData = new FormData();
  formData.append("file", input.file);
  if (input.password && input.password.length > 0) {
    formData.append("password", input.password);
  }
  xhr.send(formData);
  return promise;
}

// ---------------------------------------------------------------------------
// Server transport: runtime-only INTERNAL_API_URL, session cookie only.
// ---------------------------------------------------------------------------

export function internalApiUrl(): string {
  const url = process.env.INTERNAL_API_URL;
  if (!url) {
    throw new Error("INTERNAL_API_URL is not configured.");
  }
  return url;
}

function serverHeaders(cookieHeader: string | undefined): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  const match = cookieHeader?.match(/(?:^|;\s*)archive_session=([^;]*)/);
  if (match) {
    headers.Cookie = `${SESSION_COOKIE}=${match[1]}`;
  }
  return headers;
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

export async function serverListArchives(
  cookieHeader: string | undefined,
): Promise<ApiResult<{ archives: ArchiveItem[] }>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  return request<{ archives: ArchiveItem[] }>(`${baseUrl}/api/archives`, {
    headers: serverHeaders(cookieHeader),
  });
}

export async function serverGetArchiveDetail(
  cookieHeader: string | undefined,
  archiveId: string,
  params?: { parent?: string; q?: string },
): Promise<ApiResult<ArchiveDetail>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  const qs = new URLSearchParams();
  if (params?.parent !== undefined) qs.set("parent", params.parent);
  if (params?.q) qs.set("q", params.q);
  const query = qs.toString();
  return request<ArchiveDetail>(
    `${baseUrl}/api/archives/${encodeURIComponent(archiveId)}${query ? `?${query}` : ""}`,
    { headers: serverHeaders(cookieHeader) },
  );
}
