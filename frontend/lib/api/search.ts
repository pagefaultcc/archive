import { request } from "./core";

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

export function browserSearchArchiveEntries(
  params: SearchParams,
  options?: AbortSignal | { signal?: AbortSignal },
) {
  const signal =
    options && "aborted" in options ? options : options?.signal;
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
    signal,
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
