import { request } from "./core";

export type CredentialItem = {
  id: number;
  archiveId: string;
  archiveFilename: string;
  entryPath: string;
  entryName: string;
  url: string;
  domain: string;
  login: string;
  password: string;
};

export type CredentialsSearchResponse = {
  results: CredentialItem[];
  totalCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export function browserSearchCredentials(
  params: { q?: string; limit?: number; offset?: number },
  options?: { signal?: AbortSignal },
) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset !== undefined) sp.set("offset", String(params.offset));
  return request<CredentialsSearchResponse>(`/api/passwords?${sp.toString()}`, {
    method: "GET",
    signal: options?.signal,
  });
}
