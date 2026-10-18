"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Download,
  FileCode,
  FileText,
  Globe,
  Loader2,
  RotateCcw,
  Search,
  Shuffle,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  browserAddValidationDomain,
  browserAddValidationLog,
  browserListCookieDomainLogs,
  browserListCookieDomains,
  browserReindexAllArchives,
  cookieBulkDownloadUrl,
} from "@/lib/api";
import { CodeViewer } from "@/components/code-viewer";
import type { CookieDomainLogItem, CookieDomainSummary } from "@/lib/api";
import { cn, copyToClipboard } from "@/lib/utils";

const cachedDomainLogsMap = new Map<string, CookieDomainLogItem[]>();

export function CookiesVault() {
  const [loadedDomains, setLoadedDomains] = useState<CookieDomainSummary[]>([]);
  const [filteredCount, setFilteredCount] = useState<number>(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingDomains, setIsLoadingDomains] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [domainQuery, setDomainQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  const [totalDomains, setTotalDomains] = useState(0);
  const [totalLogs, setTotalLogs] = useState(0);
  const [totalCookies, setTotalCookies] = useState(0);

  const [selectedDomain, setSelectedDomain] =
    useState<CookieDomainSummary | null>(null);
  const [logs, setLogs] = useState<CookieDomainLogItem[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logQuery, setLogQuery] = useState("");

  const [selectedLog, setSelectedLog] = useState<CookieDomainLogItem | null>(
    null,
  );
  const [viewFormat, setViewFormat] = useState<"netscape" | "json">("netscape");
  const [wrapLines, setWrapLines] = useState(true);
  const [randomCountInput, setRandomCountInput] = useState("100");
  const [isReindexing, setIsReindexing] = useState(false);

  const logsReqRef = useRef(0);
  const domainsAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<number | undefined>(undefined);
  const domainsContainerRef = useRef<HTMLDivElement>(null);

  const loadDomainLogs = useCallback(
    async (domainObj: CookieDomainSummary, forceRefresh = false) => {
      setSelectedDomain(domainObj);
      const cached = !forceRefresh
        ? cachedDomainLogsMap.get(domainObj.domain)
        : undefined;
      if (cached !== undefined) {
        setLogs(cached);
        setSelectedLog(cached.length > 0 ? cached[0] : null);
        setIsLoadingLogs(false);
        return;
      }

      const reqId = ++logsReqRef.current;
      setIsLoadingLogs(true);
      const res = await browserListCookieDomainLogs(domainObj.domain, "");
      if (reqId !== logsReqRef.current) return;
      setIsLoadingLogs(false);
      if (res.ok) {
        cachedDomainLogsMap.set(domainObj.domain, res.data.logs);
        setLogs(res.data.logs);
        setSelectedLog(res.data.logs.length > 0 ? res.data.logs[0] : null);
      } else {
        toast.error(res.error?.message ?? "Failed to load logs for domain.");
      }
    },
    [],
  );

  const fetchDomains = useCallback(
    async (q: string, offset: number, append: boolean) => {
      let signal = domainsAbortRef.current?.signal;
      if (!append) {
        domainsAbortRef.current?.abort();
        const ctrl = new AbortController();
        domainsAbortRef.current = ctrl;
        signal = ctrl.signal;
      }
      if (offset === 0) setIsLoadingDomains(true);
      else setIsLoadingMore(true);

      try {
        const res = await browserListCookieDomains(q, 150, offset, signal);
        if (signal?.aborted || (!res.ok && res.aborted)) return;
        if (res.ok) {
          setTotalDomains(res.data.totalDomains);
          setTotalLogs(res.data.totalLogs);
          setTotalCookies(res.data.totalCookies);
          setFilteredCount(res.data.filteredCount ?? res.data.totalDomains);
          setHasMore(res.data.hasMore ?? false);

          if (append) {
            setLoadedDomains((prev) => [...prev, ...res.data.domains]);
          } else {
            setLoadedDomains(res.data.domains);
            setScrollTop(0);
            if (domainsContainerRef.current) {
              domainsContainerRef.current.scrollTop = 0;
            }
            if (res.data.domains.length > 0) {
              void loadDomainLogs(res.data.domains[0], false);
            } else {
              logsReqRef.current++;
              setSelectedDomain(null);
              setLogs([]);
              setSelectedLog(null);
              setIsLoadingLogs(false);
            }
          }
        }
      } catch {
        // Aborted or network error
      } finally {
        if (!signal?.aborted && !domainsAbortRef.current?.signal.aborted) {
          setIsLoadingDomains(false);
          setIsLoadingMore(false);
        }
      }
    },
    [loadDomainLogs],
  );

  useEffect(() => {
    void fetchDomains("", 0, false);
    return () => {
      domainsAbortRef.current?.abort();
    };
  }, [fetchDomains]);

  useEffect(() => {
    const el = domainsContainerRef.current;
    if (!el) return;
    if (el.clientHeight > 0) {
      setContainerHeight(el.clientHeight);
    }
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height || el.clientHeight;
        if (h > 0) {
          setContainerHeight(h);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleDomainSearch = (val: string) => {
    setDomainQuery(val);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      void fetchDomains(val, 0, false);
    }, 200);
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    setScrollTop(t.scrollTop);
    if (t.clientHeight !== containerHeight) {
      setContainerHeight(t.clientHeight);
    }
    if (
      hasMore &&
      !isLoadingMore &&
      !isLoadingDomains &&
      t.scrollTop + t.clientHeight >= t.scrollHeight - 350
    ) {
      void fetchDomains(domainQuery, loadedDomains.length, true);
    }
  };

  const ROW_HEIGHT = 46;
  const OVERSCAN = 6;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    loadedDomains.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleDomains = loadedDomains.slice(startIndex, endIndex);
  const paddingTop = startIndex * ROW_HEIGHT;
  const paddingBottom = Math.max(
    0,
    (loadedDomains.length - endIndex) * ROW_HEIGHT,
  );

  const filteredLogs = useMemo(() => {
    const q = logQuery.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(
      (it) =>
        it.entryPath.toLowerCase().includes(q) ||
        it.archiveFilename.toLowerCase().includes(q) ||
        it.entryName.toLowerCase().includes(q),
    );
  }, [logs, logQuery]);

  const handleReindex = async () => {
    if (isReindexing) return;
    setIsReindexing(true);
    toast.info("Extracting & indexing cookies across all archives…");
    const res = await browserReindexAllArchives();
    setIsReindexing(false);
    if (res.ok) {
      cachedDomainLogsMap.clear();
      toast.success(
        `Indexed cookies across ${res.data.reindexed} of ${res.data.total} archives.`,
      );
      void fetchDomains("", 0, false);
    } else {
      toast.error(res.error?.message ?? "Reindexing failed.");
    }
  };

  const topWebsite = selectedDomain?.domain ?? loadedDomains[0]?.domain ?? "—";

  const activeText = useMemo(() => {
    if (!selectedLog) return "";
    return viewFormat === "json"
      ? selectedLog.jsonText
      : selectedLog.netscapeText;
  }, [selectedLog, viewFormat]);

  const parsedRandomCount = useMemo(() => {
    const n = parseInt(randomCountInput, 10);
    return Number.isFinite(n) && n > 0 ? n : 100;
  }, [randomCountInput]);

  const isSupportedDomain = Boolean(
    selectedDomain &&
      (selectedDomain.domain === "openai.com" ||
        selectedDomain.domain.endsWith(".openai.com") ||
        selectedDomain.domain === "chatgpt.com" ||
        selectedDomain.domain.endsWith(".chatgpt.com")),
  );

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-4">
      {/* Architectural Obsidian Telemetry Ribbon */}
      <section className="obsidian-panel grid grid-cols-1 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Unique Domains</span>
            <Globe className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {totalDomains.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">root domains</span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Separated Logs</span>
            <FileText className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {totalLogs.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">source files</span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Total Cookies</span>
            <span className="obsidian-pill max-w-[140px] truncate font-mono text-[10px]">
              {topWebsite}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {totalCookies.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">tokens</span>
          </div>
        </div>
      </section>

      {/* Selected Domain Action Bar */}
      {selectedDomain ? (
        <section className="obsidian-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="size-3.5 text-[#8b909a]" />
            <span className="font-mono text-xs font-semibold text-[#f3f4f6]">
              {selectedDomain.domain}
            </span>
            <span className="obsidian-badge-active font-mono text-[10.5px]">
              {selectedDomain.logCount.toLocaleString()} logs
            </span>
            <span className="obsidian-pill font-mono text-[10.5px]">
              {selectedDomain.totalCookies.toLocaleString()} cookies
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="xs"
              className="h-7 gap-1.5 rounded-md border-white/[0.08] bg-[#101216] px-2.5 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              <a
                href={cookieBulkDownloadUrl(
                  selectedDomain.domain,
                  undefined,
                  viewFormat,
                )}
                download
              >
                <Download className="size-3" />
                Export All ({selectedDomain.logCount}) .zip
              </a>
            </Button>

            <div className="flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-[#101216] px-2">
              <span className="text-[11px] text-[#6b707b]">Sample:</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={randomCountInput}
                onChange={(e) => setRandomCountInput(e.target.value)}
                className="w-12 bg-transparent text-center font-mono text-xs text-[#f3f4f6] focus:outline-none"
                aria-label="Random cookie log count"
              />
              <Button
                asChild
                variant="ghost"
                size="xs"
                className="h-5 gap-1 rounded px-1.5 text-[11px] text-[#c8ccd4] hover:text-white"
              >
                <a
                  href={cookieBulkDownloadUrl(
                    selectedDomain.domain,
                    parsedRandomCount,
                    viewFormat,
                  )}
                  download
                >
                  <Shuffle className="size-2.5" />
                  .zip
                </a>
              </Button>
            </div>

            {isSupportedDomain ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={async () => {
                  if (!selectedDomain) return;
                  toast.loading(`Sending ${selectedDomain.domain} to Validator…`, {
                    id: "val-domain",
                  });
                  const res = await browserAddValidationDomain(
                    selectedDomain.domain,
                    "chatgpt",
                  );
                  if (res.ok) {
                    toast.success(
                      res.data.message ||
                        `Queued ${selectedDomain.domain} to Validator!`,
                      { id: "val-domain" },
                    );
                  } else {
                    toast.error(
                      res.error?.message ?? "Failed to send to validator",
                      { id: "val-domain" },
                    );
                  }
                }}
                className="h-7 gap-1.5 rounded-md border-white/[0.08] bg-[#101216] px-2.5 text-xs text-[#e5e7eb] hover:bg-white/[0.06]"
              >
                <CheckCircle2 className="size-3 text-[#10b981]" />
                Send All to Validator
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 3-Pane Cookies Workspace */}
      <div className="grid min-h-[620px] grid-cols-1 gap-4 lg:grid-cols-[16.5rem_minmax(0,0.95fr)_minmax(0,1.2fr)]">
        {/* Pane 1: Virtualized Domain List */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-white/[0.06] bg-[#101216]/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-semibold text-[#f3f4f6]">
                Domains (
                {filteredCount > 0
                  ? filteredCount.toLocaleString()
                  : totalDomains.toLocaleString()}
                )
              </span>
              <button
                type="button"
                onClick={() => void handleReindex()}
                disabled={isReindexing}
                title="Re-extract and index cookies across all archives"
                className="obsidian-pill gap-1 text-[10px] text-[#c8ccd4] hover:bg-white/[0.06] hover:text-white cursor-pointer disabled:opacity-50"
              >
                <RotateCcw
                  className={cn("size-2.5", isReindexing && "animate-spin")}
                />
                {isReindexing ? "Indexing…" : "Reindex"}
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#6b707b]" />
              <Input
                type="search"
                value={domainQuery}
                onChange={(e) => handleDomainSearch(e.target.value)}
                placeholder="Filter domains…"
                className="obsidian-input h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div
            ref={domainsContainerRef}
            onScroll={handleScroll}
            className="max-h-[600px] flex-1 divide-y divide-white/[0.04] overflow-y-auto"
          >
            {isLoadingDomains && loadedDomains.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
                <Loader2 className="size-4 animate-spin" />
                Loading domains…
              </div>
            ) : loadedDomains.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-xs text-[#6b707b]">
                  {domainQuery
                    ? `No domains match "${domainQuery}".`
                    : "No domain cookies indexed yet."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void handleReindex()}
                  disabled={isReindexing}
                  className="h-7 gap-1.5 rounded-md border-white/[0.08] bg-[#101216] text-xs"
                >
                  <RotateCcw
                    className={cn("size-3", isReindexing && "animate-spin")}
                  />
                  {isReindexing ? "Indexing…" : "Index Existing Archives"}
                </Button>
              </div>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <div style={{ height: `${paddingTop}px` }} aria-hidden />
                ) : null}

                {visibleDomains.map((dom) => {
                  const isActive = selectedDomain?.domain === dom.domain;
                  return (
                    <button
                      key={dom.domain}
                      type="button"
                      style={{ height: `${ROW_HEIGHT}px` }}
                      onClick={() => {
                        setLogQuery("");
                        void loadDomainLogs(dom, false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 text-left transition-none cursor-pointer",
                        isActive
                          ? "bg-white/[0.06] text-[#f3f4f6]"
                          : "text-[#8b909a] hover:bg-white/[0.025] hover:text-[#e5e7eb]",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Globe className="size-3.5 shrink-0 text-[#5c606a]" />
                        <span className="truncate font-mono text-xs font-medium">
                          {dom.domain}
                        </span>
                      </div>
                      <span className="obsidian-pill shrink-0 font-mono text-[10px]">
                        {dom.logCount.toLocaleString()}
                      </span>
                    </button>
                  );
                })}

                {paddingBottom > 0 ? (
                  <div style={{ height: `${paddingBottom}px` }} aria-hidden />
                ) : null}

                {isLoadingMore ? (
                  <div className="flex items-center justify-center py-2.5 font-mono text-xs text-[#8b909a]">
                    <Loader2 className="mr-1.5 size-3 animate-spin" />
                    Loading more…
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        {/* Pane 2: Separated Cookie Logs for Selected Domain */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-white/[0.06] bg-[#101216]/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-semibold text-[#f3f4f6]">
                {selectedDomain
                  ? `${selectedDomain.domain} (${filteredLogs.length})`
                  : "Source Logs"}
              </span>
              <span className="obsidian-pill text-[10px]">Per-Archive</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#6b707b]" />
              <Input
                type="search"
                value={logQuery}
                onChange={(e) => setLogQuery(e.target.value)}
                disabled={!selectedDomain}
                placeholder="Filter by archive or path…"
                className="obsidian-input h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="max-h-[600px] flex-1 divide-y divide-white/[0.04] overflow-y-auto">
            {isLoadingLogs ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
                <Loader2 className="size-4 animate-spin" />
                Loading separated logs…
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#6b707b]">
                No logs found for this domain.
              </div>
            ) : (
              filteredLogs.map((item) => {
                const isSelected = selectedLog?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex flex-col gap-1 px-3.5 py-2.5 transition-none",
                      isSelected ? "bg-white/[0.06]" : "hover:bg-white/[0.02]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedLog(item)}
                      className="flex min-w-0 w-full items-center justify-between gap-2 text-left cursor-pointer"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="size-3.5 shrink-0 text-[#8b909a]" />
                        <span className="truncate font-mono text-xs font-medium text-[#f3f4f6]">
                          {item.entryName}
                        </span>
                      </div>
                      <span className="obsidian-pill shrink-0 font-mono text-[10px]">
                        {item.cookieCount} cookies
                      </span>
                    </button>

                    <div className="flex items-center justify-between pt-0.5">
                      <Link
                        href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.entryPath)}`}
                        className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10.5px] text-[#6b707b] hover:text-[#c8ccd4] hover:underline"
                      >
                        <span className="truncate">
                          {item.archiveFilename} / {item.entryPath}
                        </span>
                      </Link>

                      {item.domain === "openai.com" ||
                      item.domain.endsWith(".openai.com") ||
                      item.entryPath.toLowerCase().includes("openai") ? (
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            toast.loading("Sending to Validator…", {
                              id: `val-${item.id}`,
                            });
                            const res = await browserAddValidationLog(
                              item.id,
                              "chatgpt",
                            );
                            if (res.ok) {
                              toast.success("Queued to Validator!", {
                                id: `val-${item.id}`,
                              });
                            } else {
                              toast.error(
                                res.error?.message ?? "Failed to queue log",
                                { id: `val-${item.id}` },
                              );
                            }
                          }}
                          className="obsidian-pill ml-2 shrink-0 gap-1 text-[10px] text-[#c8ccd4] hover:bg-white/[0.06] hover:text-white cursor-pointer"
                        >
                          <CheckCircle2 className="size-2.5 text-[#10b981]" />
                          Check
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Pane 3: Stripped Domain Cookie Inspector */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          {selectedLog === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-[#5c606a]" />
              <p className="text-xs font-medium text-[#e5e7eb]">
                Select a log to inspect {selectedDomain?.domain ?? "domain"} cookies
              </p>
              <p className="max-w-xs text-[11px] text-[#6b707b]">
                Only cookies matching the selected domain are isolated here.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-[#101216]/60 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-[#f3f4f6]">
                      {selectedLog.domain}
                    </span>
                    <span className="obsidian-pill font-mono text-[10px]">
                      {selectedLog.cookieCount} cookies
                    </span>
                  </div>
                  <Link
                    href={`/archives/${selectedLog.archiveId}?path=${encodeURIComponent(selectedLog.entryPath)}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[10.5px] text-[#6b707b] hover:text-[#c8ccd4] hover:underline"
                  >
                    <span className="truncate">{selectedLog.entryPath}</span>
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <SegmentedControl
                    label="Cookie format"
                    value={viewFormat}
                    onValueChange={(value) =>
                      setViewFormat(value as "netscape" | "json")
                    }
                    options={[
                      { value: "netscape", label: "Netscape" },
                      { value: "json", label: "JSON" },
                    ]}
                    size="sm"
                  />

                  {selectedLog.domain === "openai.com" ||
                  selectedLog.domain.endsWith(".openai.com") ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={async () => {
                        toast.loading("Sending log to Validator…", {
                          id: `val-inspect-${selectedLog.id}`,
                        });
                        const res = await browserAddValidationLog(
                          selectedLog.id,
                          "chatgpt",
                        );
                        if (res.ok) {
                          toast.success("Queued to Validator!", {
                            id: `val-inspect-${selectedLog.id}`,
                          });
                        } else {
                          toast.error(
                            res.error?.message ?? "Failed to queue log",
                            { id: `val-inspect-${selectedLog.id}` },
                          );
                        }
                      }}
                      className="h-7 gap-1 rounded-md border-white/[0.08] bg-[#101216] px-2 text-xs text-[#e5e7eb]"
                    >
                      <CheckCircle2 className="size-3 text-[#10b981]" />
                      Verify
                    </Button>
                  ) : null}

                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={async () => {
                      const ok = await copyToClipboard(selectedLog.netscapeText);
                      if (ok) {
                        toast.success(
                          `Copied ${selectedLog.domain} cookies (Netscape).`,
                        );
                      } else {
                        toast.error("Failed to copy cookies.");
                      }
                    }}
                    className="h-7 gap-1 rounded-md border-white/[0.08] bg-[#101216] px-2 text-xs"
                  >
                    <Copy className="size-3" />
                    Netscape
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 rounded-md border-white/[0.08] bg-[#101216] px-2 text-xs"
                    onClick={async () => {
                      const ok = await copyToClipboard(selectedLog.jsonText);
                      if (ok) {
                        toast.success(
                          `Copied ${selectedLog.domain} cookies (JSON).`,
                        );
                      } else {
                        toast.error("Failed to copy cookies.");
                      }
                    }}
                  >
                    <Copy className="size-3" />
                    JSON
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setWrapLines((w) => !w)}
                    className="h-7 px-2 text-[#8b909a] hover:text-white"
                  >
                    <WrapText className="size-3" />
                  </Button>
                </div>
              </div>

              <div className="max-h-[560px] flex-1 overflow-auto p-3">
                <CodeViewer
                  content={activeText}
                  filename={
                    viewFormat === "json"
                      ? `${selectedLog.domain}.json`
                      : `${selectedLog.domain}.txt`
                  }
                  wrapLines={wrapLines}
                />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
