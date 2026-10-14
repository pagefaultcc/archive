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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [allDomains, setAllDomains] = useState<CookieDomainSummary[]>(
    () => cachedDomainsSnapshot?.allDomains ?? [],
  );
  const [totalDomains, setTotalDomains] = useState(
    () => cachedDomainsSnapshot?.totalDomains ?? 0,
  );
  const [totalLogs, setTotalLogs] = useState(
    () => cachedDomainsSnapshot?.totalLogs ?? 0,
  );
  const [totalCookies, setTotalCookies] = useState(
    () => cachedDomainsSnapshot?.totalCookies ?? 0,
  );
  const [isLoadingDomains, setIsLoadingDomains] = useState(
    () => cachedDomainsSnapshot === null,
  );
  const [domainQuery, setDomainQuery] = useState("");

  const [selectedDomain, setSelectedDomain] =
    useState<CookieDomainSummary | null>(
      () => cachedDomainsSnapshot?.allDomains[0] ?? null,
    );
  const [logs, setLogs] = useState<CookieDomainLogItem[]>(() => {
    const first = cachedDomainsSnapshot?.allDomains[0]?.domain;
    return first ? (cachedDomainLogsMap.get(first) ?? []) : [];
  });
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logQuery, setLogQuery] = useState("");

  const [selectedLog, setSelectedLog] = useState<CookieDomainLogItem | null>(
    () => {
      const first = cachedDomainsSnapshot?.allDomains[0]?.domain;
      const initialLogs = first ? cachedDomainLogsMap.get(first) : undefined;
      return initialLogs && initialLogs.length > 0 ? initialLogs[0] : null;
    },
  );
  const [viewFormat, setViewFormat] = useState<"netscape" | "json">("netscape");
  const [wrapLines, setWrapLines] = useState(true);
  const [randomCountInput, setRandomCountInput] = useState("100");
  const [isReindexing, setIsReindexing] = useState(false);

  const logsReqRef = useRef(0);

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

  const loadDomains = useCallback(
    async (forceRefresh = false) => {
      if (!forceRefresh && cachedDomainsSnapshot !== null) {
        setAllDomains(cachedDomainsSnapshot.allDomains);
        setTotalDomains(cachedDomainsSnapshot.totalDomains);
        setTotalLogs(cachedDomainsSnapshot.totalLogs);
        setTotalCookies(cachedDomainsSnapshot.totalCookies);
        setIsLoadingDomains(false);
        if (cachedDomainsSnapshot.allDomains.length > 0) {
          void loadDomainLogs(cachedDomainsSnapshot.allDomains[0], false);
        }
        return;
      }

      setIsLoadingDomains(true);
      const res = await browserListCookieDomains("");
      setIsLoadingDomains(false);
      if (res.ok) {
        cachedDomainsSnapshot = {
          allDomains: res.data.domains,
          totalDomains: res.data.totalDomains,
          totalLogs: res.data.totalLogs,
          totalCookies: res.data.totalCookies,
        };
        setAllDomains(res.data.domains);
        setTotalDomains(res.data.totalDomains);
        setTotalLogs(res.data.totalLogs);
        setTotalCookies(res.data.totalCookies);
        if (res.data.domains.length > 0) {
          void loadDomainLogs(res.data.domains[0], forceRefresh);
        }
      } else {
        toast.error(res.error?.message ?? "Failed to load cookie domains.");
      }
    },
    [loadDomainLogs],
  );

  useEffect(() => {
    void loadDomains(false);
  }, [loadDomains]);

  // Instant 0ms client-side domain filtering (capped to 300 rendered rows for 60fps UI)
  const domains = useMemo(() => {
    const q = domainQuery.trim().toLowerCase();
    if (!q) {
      return allDomains.slice(0, 300);
    }
    const matches: CookieDomainSummary[] = [];
    for (let i = 0; i < allDomains.length; i++) {
      const d = allDomains[i];
      if (d.domain.toLowerCase().includes(q)) {
        matches.push(d);
        if (matches.length >= 300) break;
      }
    }
    return matches;
  }, [allDomains, domainQuery]);

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

  const handleDomainSearch = (val: string) => {
    setDomainQuery(val);
    const q = val.trim().toLowerCase();
    const firstMatch = q
      ? allDomains.find((d) => d.domain.toLowerCase().includes(q))
      : allDomains[0];
    if (firstMatch && firstMatch.domain !== selectedDomain?.domain) {
      void loadDomainLogs(firstMatch, false);
    }
  };

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
      void loadDomains(true);
    } else {
      toast.error(res.error?.message ?? "Reindexing failed.");
    }
  };
  const topWebsite = selectedDomain?.domain ?? domains[0]?.domain ?? "—";

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

  return (
    <div className="flex flex-1 flex-col gap-5 spring-enter">
      {/* Top Modular Summary Strip — Websites & Domain-Separated Logs */}
      <section className="kinetics-card w-full rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <Icon3D name="key" size="md" />
            <div className="flex flex-col gap-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Indexed Vault
              </p>
              <h2 className="text-sm font-semibold tracking-tight text-[#d0d6e0]">
                Cookies Explorer
              </h2>
              <span className="text-xs text-[#8a8f98]">
                Domain-separated Netscape &amp; JSON logs
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Unique websites
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                <SpringCounter value={totalDomains} />
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Separated log files
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                <SpringCounter value={totalLogs} />
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Total cookies
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                <SpringCounter value={totalCookies} />
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Active website
              </span>
              <span className="truncate font-mono text-base font-semibold tracking-tight text-[#d0d6e0]">
                {topWebsite}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Bulk Download & Domain Action Bar */}
      {selectedDomain ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Globe className="size-4 text-[#8a8f98]" />
            <span className="font-mono text-sm font-semibold text-[#d0d6e0]">
              {selectedDomain.domain}
            </span>
            <Badge variant="secondary" className="font-mono text-[11px]">
              {selectedDomain.logCount.toLocaleString()} separate logs
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">
              {selectedDomain.totalCookies.toLocaleString()} cookies
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Download All for this domain */}
            <Button asChild variant="outline" size="xs" className="gap-1.5">
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

            {/* Download Random N for this domain */}
            <div className="flex items-center gap-1 rounded-[6px] border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)] px-1.5 py-0.5">
              <span className="text-[11px] text-[#8a8f98] pl-1">Random:</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={randomCountInput}
                onChange={(e) => setRandomCountInput(e.target.value)}
                className="w-14 bg-transparent text-center font-mono text-xs text-[#d0d6e0] focus:outline-none"
                aria-label="Random cookie log count"
              />
              <Button asChild variant="secondary" size="xs" className="h-6 gap-1">
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

            {/* Send All to Validator */}
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
              className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300"
            >
              <CheckCircle2 className="size-3" />
              Send All to Validator
            </Button>
          </div>
        </section>
      ) : null}

      {/* 3-Pane Explorer: Websites (Domains) | Per-Log Files | Stripped Cookie Viewer */}
      <div className="grid min-h-[620px] grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,0.95fr)_minmax(0,1.15fr)]">
        {/* Pane 1: Websites (Domains) */}
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          <div className="flex flex-col gap-2 border-b border-[rgba(255,255,255,0.05)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#d0d6e0]">
                Websites ({domains.length})
              </span>
              <span className="text-[11px] text-[#62666d]">Root domains</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#62666d]" />
              <Input
                type="search"
                value={domainQuery}
                onChange={(e) => handleDomainSearch(e.target.value)}
                placeholder="Search domain (chatgpt.com)…"
                className="h-7 pl-7 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 divide-y divide-[rgba(255,255,255,0.04)] overflow-y-auto max-h-[600px]">
            {isLoadingDomains ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8a8f98]">
                <Loader2 className="size-4 animate-spin" />
                Loading websites…
              </div>
            ) : domains.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-xs text-[#8a8f98]">
                  No domain cookies indexed yet.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={handleReindex}
                  disabled={isReindexing}
                  className="gap-1.5"
                >
                  <RotateCcw
                    className={cn("size-3", isReindexing && "animate-spin")}
                  />
                  {isReindexing ? "Indexing Cookies…" : "Index Existing Archives"}
                </Button>
              </div>
            ) : (
              domains.map((dom) => {
                const isActive = selectedDomain?.domain === dom.domain;
                return (
                  <button
                    key={dom.domain}
                    type="button"
                    onClick={() => {
                      setLogQuery("");
                      void loadDomainLogs(dom, false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors",
                      isActive
                        ? "bg-[rgba(255,255,255,0.07)] text-[#d0d6e0]"
                        : "text-[#8a8f98] hover:bg-[rgba(255,255,255,0.03)] hover:text-[#d0d6e0]",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Globe className="size-3.5 shrink-0 text-[#62666d]" />
                      <span className="truncate font-mono text-xs font-medium">
                        {dom.domain}
                      </span>
                    </div>
                    <Badge
                      variant="outline"
                      className="shrink-0 font-mono text-[10px] text-[#8a8f98]"
                    >
                      {dom.logCount}
                    </Badge>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Pane 2: Separated Cookie Files per Log for Selected Website */}
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          <div className="flex flex-col gap-2 border-b border-[rgba(255,255,255,0.05)] p-3">
            <div className="flex items-center justify-between">
              <span className="truncate text-xs font-medium text-[#d0d6e0]">
                {selectedDomain
                  ? `${selectedDomain.domain} — Logs (${filteredLogs.length})`
                  : "Select a website"}
              </span>
              <span className="text-[11px] text-[#62666d]">Per-log files</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#62666d]" />
              <Input
                type="search"
                value={logQuery}
                onChange={(e) => setLogQuery(e.target.value)}
                disabled={!selectedDomain}
                placeholder="Filter logs by path or IP…"
                className="h-7 pl-7 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 divide-y divide-[rgba(255,255,255,0.04)] overflow-y-auto max-h-[600px]">
            {isLoadingLogs ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8a8f98]">
                <Loader2 className="size-4 animate-spin" />
                Loading separated logs…
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#62666d]">
                No logs found for this website.
              </div>
            ) : (
              filteredLogs.map((item) => {
                const isSelected = selectedLog?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex flex-col gap-1.5 px-3.5 py-2.5 transition-colors",
                      isSelected
                        ? "bg-[rgba(255,255,255,0.07)]"
                        : "hover:bg-[rgba(255,255,255,0.025)]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedLog(item)}
                      className="flex min-w-0 w-full items-center justify-between gap-2 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="size-3.5 shrink-0 text-[#8a8f98]" />
                        <span className="truncate font-mono text-xs font-medium text-[#d0d6e0]">
                          {item.domain} — {item.entryName}
                        </span>
                      </div>
                      <Badge
                        variant="outline"
                        className="shrink-0 font-mono text-[10px]"
                      >
                        {item.cookieCount} cookies
                      </Badge>
                    </button>

                    <div className="flex items-center justify-between pt-0.5">
                      {/* Clickable path forwarding to Archive > File Viewer at that exact path */}
                      <Link
                        href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.entryPath)}`}
                        className="group inline-flex items-center gap-1 truncate font-mono text-[11px] text-[#62666d] hover:text-[#d0d6e0] hover:underline"
                        title={`Open in Archive File Viewer: ${item.archiveFilename} → ${item.entryPath}`}
                      >
                        <span className="truncate">
                          {item.archiveFilename} / {item.entryPath}
                        </span>
                        <ArrowUpRight className="size-3 shrink-0 opacity-70 group-hover:opacity-100" />
                      </Link>

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
                        className="inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors cursor-pointer shrink-0 ml-2"
                      >
                        <CheckCircle2 className="size-2.5" />
                        Check
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Pane 3: Stripped Domain Cookie Inspector (Netscape / JSON) */}
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          {selectedLog === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-[#62666d]" />
              <p className="text-[13.5px] font-medium text-[#d0d6e0]">
                Select a log to view stripped {selectedDomain?.domain ?? "domain"}{" "}
                cookies
              </p>
              <p className="max-w-xs text-xs text-[#8a8f98]">
                Only cookies belonging to the selected website are shown,
                cleanly separated from all other domains in that log file.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-[#d0d6e0]">
                      {selectedLog.domain}
                    </span>
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {selectedLog.cookieCount} cookies
                    </Badge>
                  </div>
                  <Link
                    href={`/archives/${selectedLog.archiveId}?path=${encodeURIComponent(selectedLog.entryPath)}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-[#62666d] hover:text-[#d0d6e0] hover:underline"
                  >
                    <span className="truncate">{selectedLog.entryPath}</span>
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Format Switcher: Netscape | JSON */}
                  <div className="flex items-center rounded-[6px] border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)] p-0.5">
                    <button
                      type="button"
                      onClick={() => setViewFormat("netscape")}
                      className={cn(
                        "rounded-[4px] px-2 py-0.5 font-mono text-[11px] transition-colors",
                        viewFormat === "netscape"
                          ? "bg-[rgba(255,255,255,0.1)] text-[#d0d6e0]"
                          : "text-[#62666d] hover:text-[#d0d6e0]",
                      )}
                    >
                      Netscape
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewFormat("json")}
                      className={cn(
                        "rounded-[4px] px-2 py-0.5 font-mono text-[11px] transition-colors",
                        viewFormat === "json"
                          ? "bg-[rgba(255,255,255,0.1)] text-[#d0d6e0]"
                          : "text-[#62666d] hover:text-[#d0d6e0]",
                      )}
                    >
                      JSON
                    </button>
                  </div>

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
                    className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300"
                  >
                    <CheckCircle2 className="size-3" />
                    Send to Validator
                  </Button>

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
                    className="gap-1.5"
                  >
                    <Copy className="size-3" />
                    Copy (Netscape)
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
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
