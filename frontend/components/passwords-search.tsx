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
      {/* SpinupMail 3-Card Telemetry Header */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MotionSurface busy={isSearching}>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <KeyRound className="size-4 text-neutral-400" />
                <span>Credential Matches</span>
              </div>
              <span className="spinup-pill">URL + Domain</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                <SpringCounter value={totalCount} />
              </span>
              <span className="text-xs text-neutral-500">pairs</span>
            </div>
          </div>
        </MotionSurface>

        <MotionSurface>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <Zap className="size-4 text-neutral-400" />
                <span>Query Latency</span>
              </div>
              <span className="spinup-pill">Trigram GIN</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                {searchDurationMs !== null ? `${searchDurationMs}` : "—"}
              </span>
              <span className="text-xs text-neutral-500">ms</span>
            </div>
          </div>
        </MotionSurface>

        <MotionSurface>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                {showPasswords ? (
                  <Eye className="size-4 text-neutral-400" />
                ) : (
                  <EyeOff className="size-4 text-neutral-400" />
                )}
                <span>Password Visibility</span>
              </div>
              <span className="spinup-pill">{showPasswords ? "Revealed" : "Masked"}</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-xl font-semibold tracking-tight text-white">
                {results.length.toLocaleString()} loaded
              </span>
              <span className="text-xs text-neutral-500">({PAGE_SIZE}/page)</span>
            </div>
          </div>
        </MotionSurface>
      </section>

      {/* Search Input Bar */}
      <section className="spinup-card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-0 basis-full items-center gap-2.5 rounded-lg border border-white/[0.08] bg-[#0e0f11] px-3.5 transition-none focus-within:border-white/20 sm:flex-1 sm:basis-0">
            <Search className="size-4 shrink-0 text-neutral-400" />
            <input
              type="search"
              value={q}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleImmediateSearch();
              }}
              placeholder="Search by URL or domain (e.g. auth.openai.com)"
              className="min-w-0 w-full bg-transparent font-mono text-xs text-white outline-none placeholder:text-neutral-500"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowPasswords((s) => !s)}
            aria-pressed={showPasswords}
            className="h-10 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-xs text-neutral-200 transition-none hover:scale-100 active:scale-100 hover:bg-white/[0.04] hover:text-white"
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
            className="motion-sheen h-10 gap-1.5 rounded-lg text-xs transition-none hover:scale-100 active:scale-100"
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

      {/* SpinupMail Results Table Card */}
      <section className="spinup-card flex min-w-0 flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-white/[0.07] bg-[#0e0f11]/60 hover:bg-transparent">
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400 min-w-[200px]">
                  URL
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400 min-w-[160px]">
                  Login
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400 min-w-[180px]">
                  Password
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400 min-w-[220px]">
                  Archive
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400 min-w-[150px]">
                  Source file
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((item, idx) => (
                <TableRow
                  key={`${item.id}-${idx}`}
                  className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-none"
                >
                  <TableCell className="max-w-[260px] py-3 px-4 font-mono text-xs text-white">
                    <span className="block truncate" title={item.url || item.domain || "—"}>
                      {item.url || item.domain || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[200px] py-3 px-4 font-mono text-xs text-neutral-200">
                    <span className="block truncate" title={item.login || "—"}>
                      {item.login || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "font-mono text-xs max-w-[160px] truncate select-all",
                          showPasswords ? "text-white" : "text-neutral-500 tracking-widest",
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
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-white/[0.06] hover:text-white transition-none outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                        title="Copy password"
                      >
                        <Copy className="size-3.5" />
                      </button>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[240px] py-3 px-4">
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={`/archives/${item.archiveId}`}
                        className="font-mono text-xs text-white hover:underline truncate"
                        title={item.archiveFilename}
                      >
                        {item.archiveFilename}
                      </Link>
                      <span
                        className="font-mono text-[11px] text-neutral-500 truncate"
                        title={item.entryPath}
                      >
                        {item.entryPath}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[180px] py-3 px-4">
                    <span
                      className="spinup-pill font-mono text-[11px] truncate inline-block max-w-full"
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
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-neutral-400">
              <Loader2 className="size-4 animate-spin" />
              Searching credentials...
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-xs text-neutral-500">
              <p>
                No credentials matched. Password files are parsed when archives are indexed/reindexed.
              </p>
              <p className="text-[11px] text-neutral-400">
                Hint: Existing archives need reindex (
                <Link href="/settings" className="underline hover:text-white">
                  Settings → Reindex
                </Link>
                ) to backfill.
              </p>
            </div>
          )
        ) : null}

        {hasMore && (
          <div className="flex justify-center border-t border-white/[0.06] py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={isLoadingMore}
              className="h-9 gap-2 rounded-lg border-white/[0.08] bg-[#0e0f11] px-6 text-xs text-neutral-200 transition-none hover:bg-white/[0.04]"
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
