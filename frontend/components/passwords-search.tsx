"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Search,
  Zap,
} from "lucide-react";
import { SpringCounter } from "@/components/kinetics-ui";
import { MotionSurface } from "@/components/motion-surface";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  qRef.current = q;

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

  const handleImmediateSearch = () => {
    clearTimeout(searchTimerRef.current);
    void executeSearch(q);
  };

  useEffect(() => {
    void executeSearch("");
    return () => {
      searchAbortRef.current?.abort();
      clearTimeout(searchTimerRef.current);
    };
  }, [executeSearch]);

  return (
    <div className="flex flex-1 flex-col gap-5 spring-enter">
      {/* Top Telemetry Header Card */}
      <MotionSurface busy={isSearching}>
      <section className="kinetics-card w-full rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[#d0d6e0]">
              <KeyRound className="size-5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold tracking-tight text-[#d0d6e0]">
                Credential Search
              </h2>
              <span className="text-xs text-[#8a8f98]">
                user:pass pairs indexed from stealer-log password files
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Matches
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                <SpringCounter value={totalCount} />
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Query time
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0] flex items-center gap-1.5">
                <Zap className="size-4 text-[#8a8f98]" />
                {searchDurationMs !== null ? `${searchDurationMs} ms` : "—"}
              </span>
            </div>
          </div>
        </div>
      </section>
      </MotionSurface>

      {/* Search Input Bar */}
      <section className="flex flex-col gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-0 basis-full items-center gap-2.5 rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3.5 transition-none focus-within:border-[rgba(255,255,255,0.2)] focus-within:bg-[rgba(255,255,255,0.04)] sm:flex-1 sm:basis-0">
            <Search className="size-4 shrink-0 text-[#8a8f98]" />
            <input
              type="search"
              value={q}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleImmediateSearch();
              }}
              placeholder="Search by URL or domain (e.g. auth.openai.com)"
              className="min-w-0 w-full bg-transparent font-mono text-xs text-[#f7f8f8] outline-none placeholder:text-[#62666d]"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowPasswords((s) => !s)}
            aria-pressed={showPasswords}
            className="h-10 gap-1.5 text-xs text-[#d0d6e0] transition-none hover:scale-100 active:scale-100 hover:text-white"
          >
            {showPasswords ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {showPasswords ? "Mask passwords" : "Show passwords"}
          </Button>

          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleImmediateSearch}
            disabled={isSearching}
            className="motion-sheen h-10 gap-1.5 text-xs transition-none hover:scale-100 active:scale-100"
          >
            {isSearching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Search
          </Button>
        </div>
      </section>

      {/* Results Table Card */}
      <section className="flex min-w-0 flex-col gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-[rgba(255,255,255,0.05)] hover:bg-transparent">
                <TableHead className="text-xs font-medium text-[#8a8f98] min-w-[200px]">
                  URL
                </TableHead>
                <TableHead className="text-xs font-medium text-[#8a8f98] min-w-[160px]">
                  Login
                </TableHead>
                <TableHead className="text-xs font-medium text-[#8a8f98] min-w-[180px]">
                  Password
                </TableHead>
                <TableHead className="text-xs font-medium text-[#8a8f98] min-w-[220px]">
                  Archive
                </TableHead>
                <TableHead className="text-xs font-medium text-[#8a8f98] min-w-[150px]">
                  Source file
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((item, idx) => (
                  <TableRow
                    key={`${item.id}-${idx}`}
                    className="border-b border-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.03)] transition-none"
                  >
                    <TableCell className="max-w-[260px] py-2.5 font-mono text-xs text-[#d0d6e0]">
                      <span className="block truncate" title={item.url || item.domain || "—"}>
                        {item.url || item.domain || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[200px] py-2.5 font-mono text-xs text-[#d0d6e0]">
                      <span className="block truncate" title={item.login || "—"}>
                        {item.login || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "font-mono text-xs max-w-[160px] truncate select-all",
                            showPasswords ? "text-[#f7f8f8]" : "text-[#8a8f98] tracking-widest",
                          )}
                          title={showPasswords ? item.password : undefined}
                        >
                          {showPasswords ? item.password : "••••••••"}
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            await copyToClipboard(item.password);
                            toast.success("Copied");
                          }}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[4px] text-[#8a8f98] hover:bg-[rgba(255,255,255,0.06)] hover:text-[#f7f8f8] transition-none outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                          title="Copy password"
                        >
                          <Copy className="size-3.5" />
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[240px] py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <Link
                          href={`/archives/${item.archiveId}`}
                          className="font-mono text-xs text-[#d0d6e0] hover:text-white hover:underline truncate"
                          title={item.archiveFilename}
                        >
                          {item.archiveFilename}
                        </Link>
                        <span
                          className="font-mono text-[11px] text-[#62666d] truncate"
                          title={item.entryPath}
                        >
                          {item.entryPath}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[180px] py-2.5">
                      <span
                        className="font-mono text-xs text-[#8a8f98] truncate block"
                        title={item.entryPath || item.entryName}
                      >
                        {item.entryName || item.entryPath || "—"}
                      </span>
                    </TableCell>
                  </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {results.length === 0 ? (
          isSearching ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8a8f98]">
              <Loader2 className="size-4 animate-spin" />
              Searching credentials...
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-xs text-[#62666d]">
              <p>
                No credentials matched. Password files are parsed when archives are indexed/reindexed.
              </p>
              <p className="text-[11px] text-[#8a8f98]">
                Hint: Existing archives need reindex (
                <Link href="/settings" className="underline hover:text-[#d0d6e0]">
                  Settings → Reindex
                </Link>
                ) to backfill.
              </p>
            </div>
          )
        ) : null}

        {hasMore && (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={isLoadingMore}
              className="h-9 gap-2 px-6 text-xs text-[#d0d6e0] transition-none"
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading...
                </>
              ) : (
                `Load more (${results.length} of ${totalCount.toLocaleString()})`
              )}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
