import { request } from "./core";

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
  filteredCount?: number;
  hasMore?: boolean;
  limit?: number;
  offset?: number;
};

export type CookieDomainLogsResponse = {
  domain: string;
  logs: CookieDomainLogItem[];
};

export function browserListCookieDomains(
  q?: string,
  limit = 100,
  offset = 0,
  signal?: AbortSignal,
) {
  const p = new URLSearchParams();
  if (q && q.trim()) p.set("q", q.trim());
  if (limit) p.set("limit", String(limit));
  if (offset) p.set("offset", String(offset));
  return request<CookieDomainsListResponse>(`/api/cookies?${p.toString()}`, {
    method: "GET",
    signal,
  });
}

export function browserListCookieDomainLogs(
  domain: string,
  q?: string,
  options?: AbortSignal | { signal?: AbortSignal },
) {
  const signal =
    options && "aborted" in options ? options : options?.signal;
  const params = new URLSearchParams({ domain });
  if (q && q.trim()) params.set("q", q.trim());
  return request<CookieDomainLogsResponse>(`/api/cookies?${params.toString()}`, {
    method: "GET",
    signal,
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
