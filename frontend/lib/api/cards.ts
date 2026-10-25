import { request } from "./core";

export type CardItem = {
  id: number;
  archiveId: string;
  archiveFilename: string;
  entryPath: string;
  entryName: string;
  holder: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  brand: string;
};

export type CardsSearchResponse = {
  results: CardItem[];
  totalCount: number;
  vaultTotal?: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export function browserSearchCards(
  params: { q?: string; limit?: number; offset?: number },
  options?: { signal?: AbortSignal },
) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset !== undefined) sp.set("offset", String(params.offset));
  return request<CardsSearchResponse>(`/api/cards?${sp.toString()}`, {
    method: "GET",
    signal: options?.signal,
  });
}
