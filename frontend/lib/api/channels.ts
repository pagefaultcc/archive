import { jsonInit, request } from "./core";

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

export type TelegramQueueStatus = {
  active: TelegramImportJob | null;
  activeList?: TelegramImportJob[];
  totalSpeedMbps?: number;
  pendingCount: number;
  pending: TelegramImportJob[];
  completed: TelegramImportJob[];
};

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
