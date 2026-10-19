"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Search,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  browserSearchCredentials,
  type CredentialItem,
} from "@/lib/api";
import { cn, copyToClipboard } from "@/lib/utils";

const PAGE_SIZE = 200;

export function PasswordsSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CredentialItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchDurationMs, setSearchDurationMs] = useState<number | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);

  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchAbortRef = useRef<AbortController | null>(null);
  const offsetRef = useRef(0);
  const qRef = useRef(q);
  useEffect(() => {
    qRef.current = q;
  }, [q]);

  const executeSearch = useCallback(async (queryOverride?: string) => {
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;

    setIsSearching(true);
    const query = (
      queryOverride !== undefined ? queryOverride : qRef.current
    ).trim();
    const t0 = performance.now();

    try {
      const res = await browserSearchCredentials(
        {
          q: query || undefined,
          limit: PAGE_SIZE,
          offset: 0,
        },
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || (!res.ok && res.aborted)) return;
      const dt = Math.round(performance.now() - t0);
      setSearchDurationMs(dt);

      if (res.ok) {
        setResults(res.data.results);
        setTotalCount(res.data.totalCount);
        setHasMore(res.data.hasMore);
        offsetRef.current = res.data.results.length;
      } else {
        toast.error(res.error?.message ?? "Failed to search credentials.");
      }
    } catch {
      // Aborted or network error
    } finally {
      if (!ctrl.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);

    const query = qRef.current.trim();
    const currentOffset = offsetRef.current;
    const signal = searchAbortRef.current?.signal;

    try {
      const res = await browserSearchCredentials(
        {
          q: query || undefined,
          limit: PAGE_SIZE,
          offset: currentOffset,
        },
        { signal },
      );
      if (signal?.aborted || (!res.ok && res.aborted)) return;

      if (res.ok) {
        setResults((prev) => [...prev, ...res.data.results]);
        setTotalCount(res.data.totalCount);
        setHasMore(res.data.hasMore);
        offsetRef.current = currentOffset + res.data.results.length;
      } else {
        toast.error(res.error?.message ?? "Failed to load more credentials.");
      }
    } catch {
      // Aborted or network error
    } finally {
      if (!signal?.aborted) {
        setIsLoadingMore(false);
      }
    }
  }, [hasMore, isLoadingMore]);

  const handleQueryChange = (val: string) => {
    setQ(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      void executeSearch(val);
    }, 250);
  };

  useEffect(() => {
    queueMicrotask(() => {
      void executeSearch("");
    });
    return () => {
      searchAbortRef.current?.abort();
      clearTimeout(searchTimerRef.current);
    };
  }, [executeSearch]);

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-4">
      {/* Credential Search Command Bar */}
      <section className="obsidian-panel flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 min-w-0 basis-full items-center gap-2.5 rounded-lg border border-white/[0.08] bg-[#101216] px-3 focus-within:border-white/20 sm:flex-1 sm:basis-0">
            <Search className="size-3.5 shrink-0 text-[#6b707b]" />
            <input
              type="search"
              value={q}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  clearTimeout(searchTimerRef.current);
                  void executeSearch(q);
                }
              }}
              placeholder="Filter credentials by URL or root domain (e.g. auth.openai.com, github.com)..."
              className="min-w-0 w-full bg-transparent font-mono text-xs text-[#f3f4f6] outline-none placeholder:text-[#5c606a]"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowPasswords((s) => !s)}
            aria-pressed={showPasswords}
            className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#c8ccd4] hover:bg-white/[0.04] hover:text-white"
          >
            {showPasswords ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
            {showPasswords ? "Mask Passwords" : "Reveal Passwords"}
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={() => {
              clearTimeout(searchTimerRef.current);
              void executeSearch(q);
            }}
            disabled={isSearching}
            className="h-9 gap-1.5 rounded-lg bg-[#f3f4f6] px-4 text-xs font-medium text-[#050506] hover:bg-white"
          >
            {isSearching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Search
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#8b909a]">
          <span>
            Showing{" "}
            <strong className="text-[#f3f4f6]">
              {results.length.toLocaleString()}
            </strong>{" "}
            of{" "}
            <strong className="text-[#f3f4f6]">
              {totalCount.toLocaleString()}
            </strong>{" "}
            credential pairs
          </span>
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3 text-[#10b981]" />
            {searchDurationMs !== null ? `${searchDurationMs} ms` : "—"}
          </span>
        </div>
      </section>

      {/* Credentials Ledger */}
      <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/[0.06] bg-[#101216]/70 text-[11px] font-medium text-[#8b909a]">
                <th className="py-2.5 px-4 font-medium min-w-[220px]">
                  URL / Origin
                </th>
                <th className="py-2.5 px-4 font-medium min-w-[160px]">
                  Login
                </th>
                <th className="py-2.5 px-4 font-medium min-w-[180px]">
                  Password
                </th>
                <th className="py-2.5 px-4 font-medium min-w-[200px]">
                  Container
                </th>
                <th className="py-2.5 px-4 font-medium min-w-[140px]">
                  Source File
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {results.map((item, idx) => (
                <tr
                  key={`${item.id}-${idx}`}
                  className="transition-colors hover:bg-white/[0.02]"
                >
                  <td className="max-w-[260px] py-2.5 px-4 font-mono text-xs text-[#f3f4f6]">
                    <span
                      className="block truncate"
                      title={item.url || item.domain || "—"}
                    >
                      {item.url || item.domain || "—"}
                    </span>
                  </td>
                  <td className="max-w-[200px] py-2.5 px-4 font-mono text-xs text-[#c8ccd4]">
                    <span className="block truncate" title={item.login || "—"}>
                      {item.login || "—"}
                    </span>
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "max-w-[160px] truncate select-all font-mono text-xs",
                          showPasswords
                            ? "text-[#f3f4f6]"
                            : "tracking-widest text-[#6b707b]",
                        )}
                        title={showPasswords ? item.password : undefined}
                      >
                        {showPasswords ? item.password : "••••••••"}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await copyToClipboard(item.password);
                          toast.success("Copied password");
                        }}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-[#8b909a] hover:bg-white/[0.06] hover:text-white cursor-pointer"
                        title="Copy password"
                      >
                        <Copy className="size-3" />
                      </button>
                    </div>
                  </td>
                  <td className="max-w-[240px] py-2.5 px-4">
                    <Link
                      href={`/archives/${item.archiveId}`}
                      className="block truncate font-mono text-xs text-[#f3f4f6] hover:underline"
                      title={item.archiveFilename}
                    >
                      {item.archiveFilename}
                    </Link>
                  </td>
                  <td className="max-w-[180px] py-2.5 px-4">
                    <span
                      className="obsidian-pill max-w-full truncate font-mono text-[10px]"
                      title={item.entryPath || item.entryName}
                    >
                      {item.entryName || item.entryPath || "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {results.length === 0 ? (
          isSearching ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
              <Loader2 className="size-4 animate-spin" />
              Searching credential index…
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-xs text-[#6b707b]">
              <p>
                No credentials matched. Password files are mined automatically during archive indexing.
              </p>
              <p className="text-[11px]">
                Run{" "}
                <Link href="/settings" className="text-[#c8ccd4] underline hover:text-white">
                  Settings → Reindex All
                </Link>{" "}
                to backfill existing archives.
              </p>
            </div>
          )
        ) : null}

        {hasMore ? (
          <div className="flex justify-center border-t border-white/[0.06] py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadMore()}
              disabled={isLoadingMore}
              className="h-8 gap-2 rounded-lg border-white/[0.08] bg-[#101216] px-5 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </>
              ) : (
                `Load more (${results.length} of ${totalCount.toLocaleString()})`
              )}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
