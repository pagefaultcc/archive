"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
  WrapText,
  Zap,
} from "lucide-react";
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
} from "@/lib/api";
import { cn, copyToClipboard } from "@/lib/utils";
import type {
  ArchiveFilePreview,
  ArchiveSearchResult,
  SearchDownloadJob,
  SearchParams,
} from "@/lib/api";

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

  const openFilePreview = useCallback(async (item: ArchiveSearchResult) => {
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
  }, []);

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
          toast.error(
            res.error?.message ?? "Search failed. Check your regex syntax.",
          );
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

  const textLines =
    preview?.kind === "text" && preview.text ? preview.text.split("\n") : [];

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-4">
      {/* Unified Search Command & Telemetry Panel */}
      <section className="obsidian-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 min-w-0 basis-full items-center gap-2.5 rounded-lg border border-white/[0.08] bg-[#101216] px-3 focus-within:border-white/20 sm:flex-1 sm:basis-0">
            <Search className="size-3.5 shrink-0 text-[#6b707b]" />
            <input
              data-vault-search-input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void executeSearch();
              }}
              placeholder="Search paths, filenames, or regex across all containers (e.g. auth.json, passwords)..."
              className="min-w-0 w-full bg-transparent font-mono text-xs text-[#f3f4f6] outline-none placeholder:text-[#5c606a]"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowAdvanced((s) => !s)}
            aria-expanded={showAdvanced}
            aria-controls="archive-search-filters"
            className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#c8ccd4] hover:bg-white/[0.04] hover:text-white"
          >
            <SlidersHorizontal className="size-3.5" />
            Filters
            {showAdvanced ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={() => void executeSearch()}
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

        {/* Extension Filter Strip + Inline Telemetry */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 flex items-center gap-1 text-[11px] text-[#6b707b]">
              <Filter className="size-3" /> Type:
            </span>
            <button
              type="button"
              onClick={() => {
                setFileType("");
                void executeSearch({ type: undefined });
              }}
              className={cn(
                "font-mono text-[11px] cursor-pointer",
                fileType === ""
                  ? "obsidian-badge-active"
                  : "obsidian-pill hover:text-[#e5e7eb]",
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
                    void executeSearch({ type: next || undefined });
                  }}
                  className={cn(
                    "font-mono text-[11px] cursor-pointer",
                    active
                      ? "obsidian-badge-active"
                      : "obsidian-pill hover:text-[#e5e7eb]",
                  )}
                >
                  .{ext}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] text-[#8b909a]">
            <span>
              <strong className="text-[#f3f4f6]">
                {totalCount.toLocaleString()}
              </strong>{" "}
              matched
            </span>
            <span className="text-[#3a3d45]">·</span>
            <span className="inline-flex items-center gap-1">
              <Zap className="size-3 text-[#10b981]" />
              {searchDurationMs !== null ? `${searchDurationMs} ms` : "—"}
            </span>
          </div>
        </div>

        {showAdvanced ? (
          <div
            id="archive-search-filters"
            className="grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-3 sm:grid-cols-3"
          >
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[#8b909a]">
                File Name Filter (Regex / Substring)
              </label>
              <Input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="e.g. passwords.txt or ^token.*"
                className="obsidian-input h-8 font-mono text-xs"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[#8b909a]">
                Custom Extension
              </label>
              <Input
                type="text"
                value={fileType}
                onChange={(e) => setFileType(e.target.value)}
                placeholder="e.g. txt, ldb, pdf, json"
                className="obsidian-input h-8 font-mono text-xs"
              />
            </div>

            <div className="flex min-w-0 items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8b909a]">
                  Min Size (KiB)
                </label>
                <Input
                  type="number"
                  min="0"
                  value={minSizeKB}
                  onChange={(e) => setMinSizeKB(e.target.value)}
                  placeholder="0"
                  className="obsidian-input h-8 font-mono text-xs"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8b909a]">
                  Max Size (KiB)
                </label>
                <Input
                  type="number"
                  min="0"
                  value={maxSizeKB}
                  onChange={(e) => setMaxSizeKB(e.target.value)}
                  placeholder="No limit"
                  className="obsidian-input h-8 font-mono text-xs"
                />
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* 2-Pane Results & Zero-Extraction File Inspector */}
      <div className="grid min-h-[640px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Left Pane: Matched Entries */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-[#101216]/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#f3f4f6]">
                Matched Files
              </span>
              <span className="obsidian-pill font-mono text-[10px]">
                {results.length} / {totalCount.toLocaleString()}
              </span>
            </div>

            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void startBulkDownload()}
              disabled={results.length === 0 || isPreparingDownload}
              className="h-7 gap-1.5 rounded-md border-white/[0.08] bg-[#101216] px-2.5 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              <Download className="size-3" />
              Export ({Math.min(totalCount, 5000)}) .zip
            </Button>
          </div>

          <div className="max-h-[640px] flex-1 divide-y divide-white/[0.04] overflow-y-auto">
            {isSearching ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
                <Loader2 className="size-4 animate-spin" />
                Scanning index…
              </div>
            ) : results.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#6b707b]">
                No files matched your search criteria.
              </div>
            ) : (
              results.map((item) => {
                const isSelected = selectedResult?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "group flex flex-col gap-1 px-4 py-2.5 transition-none",
                      isSelected ? "bg-white/[0.06]" : "hover:bg-white/[0.02]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => void openFilePreview(item)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                      >
                        <FileText className="size-3.5 shrink-0 text-[#8b909a]" />
                        <span className="truncate font-mono text-xs font-medium text-[#f3f4f6]">
                          {item.name}
                        </span>
                        <span className="obsidian-pill shrink-0 font-mono text-[10px]">
                          {formatBytes(item.sizeBytes)}
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          asChild
                          variant="ghost"
                          size="xs"
                          className="h-6 px-2 text-[11px] text-[#8b909a] hover:text-white"
                        >
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
                          </a>
                        </Button>
                        <Button
                          asChild
                          variant="outline"
                          size="xs"
                          className="h-6 rounded border-white/[0.08] bg-[#101216] px-1.5"
                        >
                          <Link
                            href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.path)}`}
                            title={`Open in Archive Inspector: ${item.archiveFilename}`}
                          >
                            <ArrowUpRight className="size-3" />
                          </Link>
                        </Button>
                      </div>
                    </div>

                    <Link
                      href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.path)}`}
                      className="inline-flex max-w-full items-center gap-1 truncate font-mono text-[10.5px] text-[#6b707b] hover:text-[#c8ccd4] hover:underline"
                    >
                      <span className="truncate">
                        {item.archiveFilename} / {item.path}
                      </span>
                    </Link>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Pane: Zero-Extraction Stream Viewer */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          {selectedResult === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-[#5c606a]" />
              <p className="text-xs font-medium text-[#e5e7eb]">
                Select a file to inspect
              </p>
              <p className="max-w-xs text-[11px] text-[#6b707b]">
                Files stream directly from archive volumes in memory without extraction to disk.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-[#101216]/60 px-4 py-2.5">
                <div className="min-w-0 max-w-full">
                  <div className="flex items-center gap-2">
                    <span
                      className="truncate font-mono text-xs font-semibold text-[#f3f4f6]"
                      title={selectedResult.name}
                    >
                      {selectedResult.name}
                    </span>
                    <span className="obsidian-pill font-mono text-[10px]">
                      {formatBytes(selectedResult.sizeBytes)}
                    </span>
                    {textLines.length >= 2500 ? (
                      <span className="obsidian-pill font-mono text-[10px] text-amber-400">
                        2,500-line cap
                      </span>
                    ) : null}
                  </div>
                  <Link
                    href={`/archives/${selectedResult.archiveId}?path=${encodeURIComponent(selectedResult.path)}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[10.5px] text-[#6b707b] hover:text-[#c8ccd4] hover:underline"
                  >
                    <span className="truncate">
                      {selectedResult.archiveFilename} / {selectedResult.path}
                    </span>
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  {preview?.kind === "text" && preview.text !== undefined ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setWrapLines((w) => !w)}
                        className="h-6 gap-1 px-2 text-[11px] text-[#8b909a] hover:text-white"
                      >
                        <WrapText className="size-3" />
                        {wrapLines ? "Wrap" : "No wrap"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-6 gap-1 px-2 text-[11px] text-[#8b909a] hover:text-white"
                        onClick={async () => {
                          const ok = await copyToClipboard(preview.text ?? "");
                          if (ok) {
                            toast.success("Copied file content to clipboard.");
                          } else {
                            toast.error("Failed to copy file content.");
                          }
                        }}
                      >
                        <Copy className="size-3" />
                        Copy
                      </Button>
                    </>
                  ) : null}

                  <Button
                    asChild
                    variant="outline"
                    size="xs"
                    className="h-6 gap-1 rounded border-white/[0.08] bg-[#101216] px-2 text-[11px]"
                  >
                    <a
                      href={archiveDownloadUrl(
                        selectedResult.archiveId,
                        selectedResult.path,
                        false,
                      )}
                      download
                    >
                      <Download className="size-3" />
                      Raw
                    </a>
                  </Button>
                  <Button
                    asChild
                    variant="outline"
                    size="xs"
                    className="h-6 gap-1 rounded border-white/[0.08] bg-[#101216] px-2 text-[11px]"
                  >
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

              <div className="max-h-[580px] flex-1 overflow-auto p-3">
                {isLoadingFile ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
                    <Loader2 className="size-4 animate-spin" />
                    Streaming {selectedResult.name}…
                  </div>
                ) : fileError ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 p-4 text-xs text-[#f3f4f6]">
                    <div className="flex items-center gap-2 font-medium text-[#f43f5e]">
                      <AlertCircle className="size-4 shrink-0" />
                      <span>Preview unavailable</span>
                    </div>
                    <p className="text-[#c8ccd4]">{fileError}</p>
                  </div>
                ) : preview?.kind === "image" && preview.base64Data ? (
                  <div className="flex items-center justify-center p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${preview.mimeType};base64,${preview.base64Data}`}
                      alt={selectedResult.name}
                      className="max-h-[480px] rounded-md border border-white/[0.08] object-contain"
                    />
                  </div>
                ) : preview?.kind === "text" ? (
                  <CodeViewer
                    content={preview.text ?? ""}
                    filename={selectedResult.name}
                    wrapLines={wrapLines}
                  />
                ) : preview?.kind === "binary" ? (
                  <pre className="overflow-x-auto rounded-md border border-white/[0.06] bg-[#08090b] p-3 font-mono text-xs leading-5 text-[#c8ccd4]">
                    {preview.hexPreview}
                  </pre>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Bulk Export Modal */}
      <Dialog
        open={isDownloadModalOpen}
        onOpenChange={(open) => {
          setIsDownloadModalOpen(open);
          if (!open) {
            clearDownloadPoll();
          }
        }}
      >
        <DialogContent className="rounded-xl border border-white/[0.08] bg-[#0b0c0e] text-[#f3f4f6] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <FileArchive className="size-4 text-[#8b909a]" />
              Packaging Search Results
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8b909a]">
              {downloadJob?.status === "ready"
                ? "Archive is ready and download has started."
                : downloadJob?.status === "error"
                  ? "Packaging encountered an error."
                  : "Streaming matched files directly into a structured .zip…"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between font-mono text-xs">
                <span className="text-[#8b909a]">
                  {downloadJob
                    ? `${downloadJob.processed} of ${downloadJob.total} files`
                    : "—"}
                </span>
                <span className="font-semibold text-[#f3f4f6]">
                  {downloadJob?.percent ?? 0}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    downloadJob?.status === "error"
                      ? "bg-[#f43f5e]"
                      : downloadJob?.status === "ready"
                        ? "bg-[#10b981]"
                        : "bg-[#f3f4f6]",
                  )}
                  style={{ width: `${downloadJob?.percent ?? 0}%` }}
                />
              </div>
            </div>

            <div className="obsidian-subpanel flex items-center justify-between gap-2 p-2.5 text-xs">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {downloadJob?.status === "preparing" ? (
                  <Loader2 className="size-3.5 animate-spin text-[#8b909a]" />
                ) : (
                  <FileArchive className="size-3.5 text-[#8b909a]" />
                )}
                <span
                  className="truncate font-mono text-[#c8ccd4]"
                  title={downloadJob?.zipName ?? "search-results.zip"}
                >
                  {downloadJob?.zipName ?? "search-results.zip"}
                </span>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "font-mono text-[10px] uppercase",
                  downloadJob?.status === "ready" &&
                    "border-emerald-500/30 text-[#10b981]",
                  downloadJob?.status === "error" &&
                    "border-rose-500/30 text-[#f43f5e]",
                )}
              >
                {downloadJob?.status ?? "preparing"}
              </Badge>
            </div>

            {downloadJob?.status === "ready" && downloadJob.downloadUrl ? (
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsDownloadModalOpen(false)}
                  className="h-8 text-xs text-[#8b909a]"
                >
                  Close
                </Button>
                <Button
                  asChild
                  size="sm"
                  className="h-8 gap-1.5 bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
                >
                  <a href={downloadJob.downloadUrl} download={downloadJob.zipName}>
                    <Download className="size-3.5" />
                    Download .zip
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
