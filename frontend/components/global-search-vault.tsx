"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileArchive,
  FileCode,
  FileText,
  Filter,
  Loader2,
  Search,
  SlidersHorizontal,
  Sparkles,
  WrapText,
  Zap,
} from "lucide-react";
import { Icon3D, SpringCounter } from "@/components/kinetics-ui";
import { MotionSurface } from "@/components/motion-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeViewer } from "@/components/code-viewer";
import {
  archiveDownloadUrl,
  browserGetSearchDownloadJob,
  browserPrepareSearchDownload,
  browserPreviewArchiveFile,
  browserSearchArchiveEntries,
  searchBulkDownloadUrl,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/utils";
import type {
  ArchiveFilePreview,
  ArchiveSearchResult,
  SearchDownloadJob,
  SearchParams,
} from "@/lib/api";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

const COMMON_EXTENSIONS = [
  "txt",
  "json",
  "log",
  "pdf",
  "docx",
  "db",
  "sqlite",
  "ldb",
  "xml",
  "csv",
  "env",
  "conf",
];

export function GlobalSearchVault() {
  const [q, setQ] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState("");
  const [minSizeKB, setMinSizeKB] = useState("");
  const [maxSizeKB, setMaxSizeKB] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [results, setResults] = useState<ArchiveSearchResult[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [searchDurationMs, setSearchDurationMs] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedResult, setSelectedResult] =
    useState<ArchiveSearchResult | null>(null);
  const [preview, setPreview] = useState<ArchiveFilePreview | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const [downloadJob, setDownloadJob] = useState<SearchDownloadJob | null>(null);
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const previewReqRef = useRef(0);
  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchAbortRef = useRef<AbortController | null>(null);
  const downloadPollRef = useRef<number | undefined>(undefined);
  const isInitialMountRef = useRef(true);

  const filtersRef = useRef({
    q,
    fileName,
    fileType,
    minSizeKB,
    maxSizeKB,
  });
  filtersRef.current = {
    q,
    fileName,
    fileType,
    minSizeKB,
    maxSizeKB,
  };

  const clearDownloadPoll = useCallback(() => {
    if (downloadPollRef.current !== undefined) {
      window.clearInterval(downloadPollRef.current);
      downloadPollRef.current = undefined;
    }
  }, []);

  const startBulkDownload = async () => {
    if (isPreparingDownload) return;
    clearDownloadPoll();
    setIsPreparingDownload(true);
    setIsDownloadModalOpen(true);
    const targetTotal = Math.min(totalCount, 5000);
    setDownloadJob({
      id: "",
      status: "preparing",
      total: targetTotal,
      processed: 0,
      percent: 0,
      zipName: `search-results-${targetTotal}-files.zip`,
    });

    const res = await browserPrepareSearchDownload({
      q: q.trim() || undefined,
      name: fileName.trim() || undefined,
      type: fileType.trim() || undefined,
      minSize: minSizeKB ? Number(minSizeKB) * 1024 : undefined,
      maxSize: maxSizeKB ? Number(maxSizeKB) * 1024 : undefined,
      limit: 5000,
    });

    setIsPreparingDownload(false);

    if (!res.ok) {
      toast.error(res.error?.message ?? "Failed to start packaging.");
      setIsDownloadModalOpen(false);
      return;
    }

    const jobId = res.data.jobId;
    downloadPollRef.current = window.setInterval(async () => {
      const pollRes = await browserGetSearchDownloadJob(jobId);
      if (pollRes.ok) {
        const job = pollRes.data;
        setDownloadJob(job);
        if (job.status === "ready") {
          clearDownloadPoll();
          toast.success(`Search results archive ready (${job.total} files).`);
          if (job.downloadUrl) {
            const a = document.createElement("a");
            a.href = job.downloadUrl;
            a.download = job.zipName || "search-results.zip";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        } else if (job.status === "error") {
          clearDownloadPoll();
          toast.error(job.error || "Failed to package archive.");
        }
      }
    }, 450);
  };

  const openFilePreview = useCallback(
    async (item: ArchiveSearchResult) => {
      const reqId = ++previewReqRef.current;
      setSelectedResult(item);
      setIsLoadingFile(true);
      setFileError(null);
      const res = await browserPreviewArchiveFile(item.archiveId, item.path);
      if (reqId !== previewReqRef.current) return;
      setIsLoadingFile(false);
      if (!res.ok) {
        if (res.aborted) return;
        setPreview(null);
        setFileError(res.error?.message ?? "Failed to read file from archive.");
        return;
      }
      setPreview(res.data);
    },
    [],
  );

  const executeSearch = useCallback(
    async (overrideParams?: Partial<SearchParams>) => {
      window.clearTimeout(searchTimerRef.current);
      searchAbortRef.current?.abort();
      const ctrl = new AbortController();
      searchAbortRef.current = ctrl;

      setIsSearching(true);
      const t0 = performance.now();
      const cur = filtersRef.current;
      const minBytes = cur.minSizeKB ? Number(cur.minSizeKB) * 1024 : undefined;
      const maxBytes = cur.maxSizeKB ? Number(cur.maxSizeKB) * 1024 : undefined;

      const params: SearchParams = {
        q: cur.q.trim() || undefined,
        name: cur.fileName.trim() || undefined,
        type: cur.fileType.trim() || undefined,
        minSize: minBytes,
        maxSize: maxBytes,
        limit: 100,
        ...overrideParams,
      };

      try {
        const res = await browserSearchArchiveEntries(params, {
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || (!res.ok && res.aborted)) return;
        const dt = Math.round(performance.now() - t0);
        setSearchDurationMs(dt);

        if (res.ok) {
          setResults(res.data.results);
          setTotalCount(res.data.totalCount);
          if (res.data.results.length > 0) {
            void openFilePreview(res.data.results[0]);
          } else {
            previewReqRef.current++;
            setSelectedResult(null);
            setPreview(null);
            setFileError(null);
            setIsLoadingFile(false);
          }
        } else {
          toast.error(res.error?.message ?? "Search failed. Check your regex syntax.");
        }
      } catch {
        // Aborted or network error
      } finally {
        if (!ctrl.signal.aborted) {
          setIsSearching(false);
        }
      }
    },
    [openFilePreview],
  );

  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      const urlQ =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("q")?.trim() ?? ""
          : "";
      if (urlQ) {
        setQ(urlQ);
        filtersRef.current.q = urlQ;
        void executeSearch({ q: urlQ });
      } else {
        void executeSearch();
      }
      return;
    }
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      void executeSearch();
    }, 250);
    return () => {
      window.clearTimeout(searchTimerRef.current);
    };
  }, [q, fileName, fileType, minSizeKB, maxSizeKB, executeSearch]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchTimerRef.current);
      searchAbortRef.current?.abort();
      clearDownloadPoll();
    };
  }, [clearDownloadPoll]);

  const handleGlobalQueryChange = (val: string) => {
    setQ(val);
  };

  const handleFileNameChange = (val: string) => {
    setFileName(val);
  };
  const textLines = preview?.kind === "text" && preview.text ? preview.text.split("\n") : [];

  return (
    <div className="flex flex-1 flex-col gap-5 spring-enter">
      {/* SpinupMail 3-Card Search Telemetry Grid */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MotionSurface busy={isSearching}>
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-400">
                <Search className="size-4 text-neutral-400" />
                <span>Indexed Entries</span>
              </div>
              <span className="spinup-pill">Trigram GIN</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums tracking-tight text-white">
                <SpringCounter value={totalCount} />
              </span>
              <span className="text-xs text-neutral-500">matched</span>
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
              <span className="spinup-pill">Engine Speed</span>
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
                <Filter className="size-4 text-neutral-400" />
                <span>Active Filters</span>
              </div>
              <span className="spinup-pill">Scope</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="truncate font-mono text-2xl font-semibold tracking-tight text-white">
                {fileType ? `.${fileType}` : "All types"}
              </span>
              {fileName ? (
                <span className="truncate font-mono text-xs text-neutral-400">
                  · {fileName}
                </span>
              ) : null}
            </div>
          </div>
        </MotionSurface>
      </section>

      {/* Main Search Bar & Quick Filters */}
      <section className="spinup-card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-0 basis-full items-center gap-2.5 rounded-lg border border-white/[0.08] bg-[#0e0f11] px-3.5 transition-none focus-within:border-white/20 sm:flex-1 sm:basis-0">
            <Search className="size-4 shrink-0 text-neutral-400" />
            <input
              data-vault-search-input
              type="search"
              value={q}
              onChange={(e) => handleGlobalQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") executeSearch();
              }}
              placeholder="Search all archives (e.g. auth.json, passwords, or regex)..."
              className="min-w-0 w-full bg-transparent font-mono text-xs text-white outline-none placeholder:text-neutral-500"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowAdvanced((s) => !s)}
            aria-expanded={showAdvanced}
            aria-controls="archive-search-filters"
            className="h-10 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-xs text-neutral-200 transition-none hover:bg-white/[0.04] hover:scale-100 active:scale-100"
          >
            <SlidersHorizontal className="size-3.5" />
            Filters
            {showAdvanced ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>

          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => executeSearch()}
            disabled={isSearching}
            className="motion-sheen h-10 gap-1.5 rounded-lg text-xs transition-none hover:scale-100 active:scale-100"
          >
            <Sparkles className={cn("size-3.5", isSearching && "animate-spin")} />
            Search
          </Button>
        </div>

        {/* Quick extension pills */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] text-neutral-500 pr-1 flex items-center gap-1">
            <Filter className="size-3" /> Quick Type:
          </span>
          <button
            type="button"
            onClick={() => {
              setFileType("");
              executeSearch({ type: undefined });
            }}
            className={cn(
              "font-mono text-[11px] transition-none cursor-pointer",
              fileType === "" ? "spinup-badge-active" : "spinup-pill hover:text-white"
            )}
          >
            All
          </button>
          {COMMON_EXTENSIONS.map((ext) => {
            const active = fileType.toLowerCase() === ext;
            return (
              <button
                key={ext}
                type="button"
                onClick={() => {
                  const next = active ? "" : ext;
                  setFileType(next);
                  executeSearch({ type: next || undefined });
                }}
                className={cn(
                  "font-mono text-[11px] transition-none cursor-pointer",
                  active ? "spinup-badge-active" : "spinup-pill hover:text-white"
                )}
              >
                .{ext}
              </button>
            );
          })}
        </div>

        {/* Collapsible Advanced Filters Drawer */}
        {showAdvanced ? (
          <div id="archive-search-filters" className="grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-neutral-400">
                File Name Filter (Regex / Substring)
              </label>
              <Input
                type="text"
                value={fileName}
                onChange={(e) => handleFileNameChange(e.target.value)}
                placeholder="e.g. passwords.txt or ^token.*"
                className="spinup-input h-8 font-mono text-xs"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-neutral-400">
                Custom Extension (Type)
              </label>
              <Input
                type="text"
                value={fileType}
                onChange={(e) => {
                  setFileType(e.target.value);
                }}
                placeholder="e.g. txt, ldb, pdf, json"
                className="spinup-input h-8 font-mono text-xs"
              />
            </div>

            <div className="flex min-w-0 items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className="text-[11px] font-medium text-neutral-400">
                  Min Size (KiB)
                </label>
                <Input
                  type="number"
                  min="0"
                  value={minSizeKB}
                  onChange={(e) => {
                    setMinSizeKB(e.target.value);
                  }}
                  placeholder="0"
                  className="spinup-input h-8 font-mono text-xs"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className="text-[11px] font-medium text-neutral-400">
                  Max Size (KiB)
                </label>
                <Input
                  type="number"
                  min="0"
                  value={maxSizeKB}
                  onChange={(e) => {
                    setMaxSizeKB(e.target.value);
                  }}
                  placeholder="No limit"
                  className="spinup-input h-8 font-mono text-xs"
                />
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* 2-Pane Results & Zero-Extraction Previewer */}
      <div className="grid min-h-[640px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Left Pane: Search Results */}
        <section className="spinup-card flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-white">
                Search Results ({results.length} of {totalCount.toLocaleString()})
              </span>
              <span className="spinup-pill font-mono text-[10px]">
                GIN trigram
              </span>
            </div>

            {results.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void startBulkDownload()}
                disabled={isPreparingDownload}
                className="gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
              >
                <Download className="size-3" />
                Download All ({Math.min(totalCount, 5000)}) .zip
              </Button>
            ) : (
              <Button variant="outline" size="xs" disabled className="gap-1.5 rounded-lg">
                <Download className="size-3" />
                Download All .zip
              </Button>
            )}
          </div>

          <div className="flex-1 divide-y divide-white/[0.04] overflow-y-auto max-h-[640px]">
            {isSearching ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-neutral-400">
                <Loader2 className="size-4 animate-spin" />
                Searching 4.6M+ entries…
              </div>
            ) : results.length === 0 ? (
              <div className="py-12 text-center text-xs text-neutral-500">
                No files matched your search specifications.
              </div>
            ) : (
              results.map((item) => {
                const isSelected = selectedResult?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "group flex flex-col gap-1 px-4 py-3 transition-none",
                      isSelected
                        ? "bg-white/[0.05]"
                        : "hover:bg-white/[0.02]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => void openFilePreview(item)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <FileText className="size-3.5 shrink-0 text-neutral-400" />
                        <span className="truncate font-mono text-xs font-medium text-white">
                          {item.name}
                        </span>
                        <span className="spinup-pill shrink-0 font-mono text-[10px]">
                          {formatBytes(item.sizeBytes)}
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button asChild variant="ghost" size="xs" className="text-neutral-400 hover:text-white">
                          <a
                            href={archiveDownloadUrl(
                              item.archiveId,
                              item.path,
                              false,
                            )}
                            download
                            title="Download raw file"
                          >
                            <Download className="size-3" />
                            File
                          </a>
                        </Button>
                        <Button asChild variant="outline" size="xs" className="rounded-lg border-white/[0.08] bg-[#0e0f11]">
                          <Link
                            href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.path)}`}
                            title={`Open in Archive Explorer: ${item.archiveFilename}`}
                          >
                            <ArrowUpRight className="size-3" />
                          </Link>
                        </Button>
                      </div>
                    </div>

                    <Link
                      href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.path)}`}
                      className="group inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-neutral-500 hover:text-neutral-200 hover:underline"
                      title={`Open in Archive File Viewer: ${item.archiveFilename} → ${item.path}`}
                    >
                      <span className="truncate">
                        {item.archiveFilename} / {item.path}
                      </span>
                      <ArrowUpRight className="size-3 shrink-0 opacity-70 group-hover:opacity-100" />
                    </Link>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Pane: Zero-Extraction File Viewer */}
        <section className="spinup-card flex min-w-0 flex-col overflow-hidden">
          {selectedResult === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-neutral-500" />
              <p className="text-sm font-medium text-white">
                Select any file to inspect
              </p>
              <p className="max-w-xs text-xs text-neutral-500">
                Files are streamed directly from archive volumes in memory without disk extraction.
              </p>
            </div>
          ) : (
            <>
              {/* File Viewer Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3">
                <div className="min-w-0 max-w-full">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-white" title={selectedResult.name}>
                      {selectedResult.name}
                    </span>
                    <span className="spinup-pill font-mono text-[10px]">
                      {formatBytes(selectedResult.sizeBytes)}
                    </span>
                    {textLines.length >= 2500 ? (
                      <span className="spinup-pill font-mono text-[10px] text-amber-400">
                        2,500-line cap
                      </span>
                    ) : null}
                  </div>
                  <Link
                    href={`/archives/${selectedResult.archiveId}?path=${encodeURIComponent(selectedResult.path)}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-neutral-500 hover:text-neutral-200 hover:underline"
                  >
                    <span className="truncate">
                      {selectedResult.archiveFilename} / {selectedResult.path}
                    </span>
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {preview?.kind === "text" && preview.text !== undefined ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setWrapLines((w) => !w)}
                        className="text-neutral-400 hover:text-white"
                      >
                        <WrapText className="size-3" />
                        {wrapLines ? "Wrapped" : "No wrap"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-neutral-400 hover:text-white"
                        onClick={async () => {
                          const ok = await copyToClipboard(preview.text ?? "");
                          if (ok) {
                            toast.success("Copied file content to clipboard.");
                          } else {
                            toast.error("Failed to copy file content to clipboard.");
                          }
                        }}
                      >
                        <Copy className="size-3" />
                        Copy
                      </Button>
                    </>
                  ) : null}

                  <Button asChild variant="outline" size="xs" className="rounded-lg border-white/[0.08] bg-[#0e0f11]">
                    <a
                      href={archiveDownloadUrl(
                        selectedResult.archiveId,
                        selectedResult.path,
                        false,
                      )}
                      download
                    >
                      <Download className="size-3" />
                      Download
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="xs" className="rounded-lg border-white/[0.08] bg-[#0e0f11]">
                    <a
                      href={archiveDownloadUrl(
                        selectedResult.archiveId,
                        selectedResult.path,
                        true,
                      )}
                      download
                    >
                      <FileArchive className="size-3" />
                      .zip
                    </a>
                  </Button>
                </div>
              </div>

              {/* File Viewer Body */}
              <div className="flex-1 overflow-auto p-3.5 max-h-[580px]">
                {isLoadingFile ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-xs text-neutral-400">
                    <Loader2 className="size-4 animate-spin" />
                    Streaming {selectedResult.name}…
                  </div>
                ) : fileError ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-[rgba(249,24,128,0.3)] bg-[rgba(249,24,128,0.08)] p-4 text-[13px] text-neutral-200">
                    <div className="flex items-center gap-2 font-medium text-[#f91880]">
                      <AlertCircle className="size-4 shrink-0" />
                      <span>Cannot preview file</span>
                    </div>
                    <p className="text-xs leading-relaxed text-neutral-200">
                      {fileError}
                    </p>
                  </div>
                ) : preview?.kind === "image" && preview.base64Data ? (
                  <div className="flex items-center justify-center p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${preview.mimeType};base64,${preview.base64Data}`}
                      alt={selectedResult.name}
                      className="max-h-[480px] rounded-lg border border-white/[0.08] object-contain"
                    />
                  </div>
                ) : preview?.kind === "text" ? (
                  <CodeViewer
                    content={preview.text ?? ""}
                    filename={selectedResult.name}
                    wrapLines={wrapLines}
                  />
                ) : preview?.kind === "binary" ? (
                  <pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-[#030405] p-3 font-mono text-xs leading-[19px] text-neutral-200">
                    {preview.hexPreview}
                  </pre>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
      {/* Interactive Bulk Download Progress Modal */}
      <Dialog
        open={isDownloadModalOpen}
        onOpenChange={(open) => {
          setIsDownloadModalOpen(open);
          if (!open) {
            clearDownloadPoll();
          }
        }}
      >
        <DialogContent className="border-[rgba(255,255,255,0.08)] bg-[#0f1011] text-[#f7f8f8] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6 text-left text-base text-[#ffffff]">
              <FileArchive className="size-4 text-[#8a8f98]" />
              Packaging Search Results Archive
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8a8f98]">
              {downloadJob?.status === "ready"
                ? "Archive is ready and download has started."
                : downloadJob?.status === "error"
                  ? "Packaging encountered an error."
                  : "Streaming files directly from archive volumes into a structured .zip…"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Progress bar and counters */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-[#8a8f98]">
                  {downloadJob ? `${downloadJob.processed} of ${downloadJob.total} files` : "—"}
                </span>
                <span className="font-semibold text-[#ffffff]">
                  {downloadJob?.percent ?? 0}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    downloadJob?.status === "error"
                      ? "bg-[#f91880]"
                      : downloadJob?.status === "ready"
                        ? "bg-[#00ba7c]"
                        : "kinetics-progress-fill",
                  )}
                  style={{ width: `${downloadJob?.percent ?? 0}%` }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.02)] p-2.5 text-xs">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {downloadJob?.status === "preparing" ? (
                  <Loader2 className="size-3.5 animate-spin text-[#8a8f98]" />
                ) : (
                  <FileArchive className="size-3.5 text-[#8a8f98]" />
                )}
                <span className="truncate font-mono text-[#d0d6e0]" title={downloadJob?.zipName ?? "search-results.zip"}>
                  {downloadJob?.zipName ?? "search-results.zip"}
                </span>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "font-mono text-[10px] uppercase",
                  downloadJob?.status === "ready" && "border-[#00ba7c] text-[#00ba7c]",
                  downloadJob?.status === "error" && "border-[#f91880] text-[#f91880]",
                )}
              >
                {downloadJob?.status ?? "preparing"}
              </Badge>
            </div>

            {downloadJob?.status === "ready" && downloadJob.downloadUrl ? (
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsDownloadModalOpen(false)}
                >
                  Done
                </Button>
                <Button asChild size="sm" variant="default" className="gap-1.5">
                  <a href={downloadJob.downloadUrl} download={downloadJob.zipName}>
                    <Download className="size-3.5" />
                    Re-download .zip
                  </a>
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
