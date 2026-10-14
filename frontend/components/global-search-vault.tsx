"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowUpRight,
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

  const startBulkDownload = async () => {
    if (isPreparingDownload) return;
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
    const pollInterval = window.setInterval(async () => {
      const pollRes = await browserGetSearchDownloadJob(jobId);
      if (pollRes.ok) {
        const job = pollRes.data;
        setDownloadJob(job);
        if (job.status === "ready") {
          window.clearInterval(pollInterval);
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
          window.clearInterval(pollInterval);
          toast.error(job.error || "Failed to package archive.");
        }
      }
    }, 450);
  };

  const previewReqRef = useRef(0);
  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchAbortRef = useRef<AbortController | null>(null);

  const executeSearch = useCallback(
    async (overrideParams?: Partial<SearchParams>) => {
      searchAbortRef.current?.abort();
      const ctrl = new AbortController();
      searchAbortRef.current = ctrl;

      setIsSearching(true);
      const t0 = performance.now();
      const minBytes = minSizeKB ? Number(minSizeKB) * 1024 : undefined;
      const maxBytes = maxSizeKB ? Number(maxSizeKB) * 1024 : undefined;

      const params: SearchParams = {
        q: q.trim() || undefined,
        name: fileName.trim() || undefined,
        type: fileType.trim() || undefined,
        minSize: minBytes,
        maxSize: maxBytes,
        limit: 100,
        ...overrideParams,
      };

      try {
        const res = await browserSearchArchiveEntries(params);
        if (ctrl.signal.aborted) return;
        const dt = Math.round(performance.now() - t0);
        setSearchDurationMs(dt);

        if (res.ok) {
          setResults(res.data.results);
          setTotalCount(res.data.totalCount);
          if (res.data.results.length > 0) {
            setSelectedResult(res.data.results[0]);
          } else {
            setSelectedResult(null);
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
    [fileName, fileType, maxSizeKB, minSizeKB, q],
  );

  useEffect(() => {
    executeSearch();
    return () => {
      searchAbortRef.current?.abort();
    };
  }, [executeSearch]);

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
        setPreview(null);
        setFileError(res.error?.message ?? "Failed to read file from archive.");
        return;
      }
      setPreview(res.data);
    },
    [],
  );

  const handleGlobalQueryChange = (val: string) => {
    setQ(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      executeSearch({ q: val.trim() || undefined });
    }, 200);
  };

  const handleFileNameChange = (val: string) => {
    setFileName(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      executeSearch({ name: val.trim() || undefined });
    }, 200);
  };

  const textLines = preview?.kind === "text" && preview.text ? preview.text.split("\n") : [];

  return (
    <div className="flex flex-1 flex-col gap-5 spring-enter">
      {/* Top Search Telemetry Card */}
      <section className="kinetics-card w-full rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[#d0d6e0]">
              <Search className="size-5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Trigram GIN Indexed
              </p>
              <h2 className="text-sm font-semibold tracking-tight text-[#d0d6e0]">
                Global Archive Search
              </h2>
              <span className="text-xs text-[#8a8f98]">
                Automatic exact, regex, &amp; substring search across 4.6M+ entries
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Matching entries
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                <SpringCounter value={totalCount} />
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Engine speed
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0] flex items-center gap-1.5">
                <Zap className="size-4 text-[#8a8f98]" />
                {searchDurationMs !== null ? `${searchDurationMs} ms` : "—"}
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Active type
              </span>
              <span className="truncate font-mono text-base font-semibold tracking-tight text-[#d0d6e0]">
                {fileType ? `.${fileType}` : "All types"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Main Search Bar & Quick Filters */}
      <section className="flex flex-col gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        {/* Search input + Regex Toggle */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Clean flex input: icon and input are natural flex siblings, zero overlap */}
          <div className="flex flex-1 min-w-[280px] items-center gap-2.5 rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2 transition-colors focus-within:border-[rgba(255,255,255,0.2)] focus-within:bg-[rgba(255,255,255,0.04)]">
            <Search className="size-4 shrink-0 text-[#8a8f98]" />
            <input
              type="search"
              value={q}
              onChange={(e) => handleGlobalQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") executeSearch();
              }}
              placeholder="Search all archives (e.g. auth.json, passwords, or regex)..."
              className="w-full bg-transparent font-mono text-xs text-[#f7f8f8] outline-none placeholder:text-[#62666d]"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowAdvanced((s) => !s)}
            className="h-10 gap-1.5 text-xs"
          >
            <SlidersHorizontal className="size-3.5" />
            Filters {showAdvanced ? "▲" : "▼"}
          </Button>

          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => executeSearch()}
            disabled={isSearching}
            className="h-10 gap-1.5 text-xs"
          >
            <Sparkles className={cn("size-3.5", isSearching && "animate-spin")} />
            Search
          </Button>
        </div>

        {/* Quick extension pills */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] text-[#62666d] pr-1 flex items-center gap-1">
            <Filter className="size-3" /> Quick Type:
          </span>
          <Button
            type="button"
            variant={fileType === "" ? "secondary" : "outline"}
            size="xs"
            onClick={() => {
              setFileType("");
              executeSearch({ type: undefined });
            }}
            className="font-mono text-[10px]"
          >
            All
          </Button>
          {COMMON_EXTENSIONS.map((ext) => {
            const active = fileType.toLowerCase() === ext;
            return (
              <Button
                key={ext}
                type="button"
                variant={active ? "secondary" : "outline"}
                size="xs"
                onClick={() => {
                  const next = active ? "" : ext;
                  setFileType(next);
                  executeSearch({ type: next || undefined });
                }}
                className="font-mono text-[10px]"
              >
                .{ext}
              </Button>
            );
          })}
        </div>

        {/* Collapsible Advanced Filters Drawer */}
        {showAdvanced ? (
          <div className="grid grid-cols-1 gap-3 border-t border-[rgba(255,255,255,0.05)] pt-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[#8a8f98]">
                File Name Filter (Regex / Substring)
              </label>
              <Input
                type="text"
                value={fileName}
                onChange={(e) => handleFileNameChange(e.target.value)}
                placeholder="e.g. passwords.txt or ^token.*"
                className="h-8 font-mono text-xs"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[#8a8f98]">
                Custom Extension (Type)
              </label>
              <Input
                type="text"
                value={fileType}
                onChange={(e) => {
                  setFileType(e.target.value);
                  clearTimeout(searchTimerRef.current);
                  searchTimerRef.current = window.setTimeout(() => {
                    executeSearch({ type: e.target.value.trim() || undefined });
                  }, 200);
                }}
                placeholder="e.g. txt, ldb, pdf, json"
                className="h-8 font-mono text-xs"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="flex-1 flex flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8a8f98]">
                  Min Size (KiB)
                </label>
                <Input
                  type="number"
                  min="0"
                  value={minSizeKB}
                  onChange={(e) => {
                    setMinSizeKB(e.target.value);
                    clearTimeout(searchTimerRef.current);
                    searchTimerRef.current = window.setTimeout(() => {
                      executeSearch();
                    }, 250);
                  }}
                  placeholder="0"
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <label className="text-[11px] font-medium text-[#8a8f98]">
                  Max Size (KiB)
                </label>
                <Input
                  type="number"
                  min="0"
                  value={maxSizeKB}
                  onChange={(e) => {
                    setMaxSizeKB(e.target.value);
                    clearTimeout(searchTimerRef.current);
                    searchTimerRef.current = window.setTimeout(() => {
                      executeSearch();
                    }, 250);
                  }}
                  placeholder="No limit"
                  className="h-8 font-mono text-xs"
                />
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* 2-Pane Results & Zero-Extraction Previewer */}
      <div className="grid min-h-[640px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Left Pane: Search Results */}
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-[#d0d6e0]">
                Search Results ({results.length} of {totalCount.toLocaleString()})
              </span>
              <span className="text-[11px] font-mono text-[#62666d]">
                GIN trigram indexed
              </span>
            </div>

            {results.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void startBulkDownload()}
                disabled={isPreparingDownload}
                className="gap-1.5"
              >
                <Download className="size-3" />
                Download All ({Math.min(totalCount, 5000)}) .zip
              </Button>
            ) : (
              <Button variant="outline" size="xs" disabled className="gap-1.5">
                <Download className="size-3" />
                Download All .zip
              </Button>
            )}
          </div>

          <div className="flex-1 divide-y divide-[rgba(255,255,255,0.04)] overflow-y-auto max-h-[640px]">
            {isSearching ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8a8f98]">
                <Loader2 className="size-4 animate-spin" />
                Searching 4.6M+ entries…
              </div>
            ) : results.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#62666d]">
                No files matched your search specifications.
              </div>
            ) : (
              results.map((item) => {
                const isSelected = selectedResult?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "group flex flex-col gap-1 px-3.5 py-2.5 transition-colors",
                      isSelected
                        ? "bg-[rgba(255,255,255,0.06)]"
                        : "hover:bg-[rgba(255,255,255,0.025)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => void openFilePreview(item)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <FileText className="size-3.5 shrink-0 text-[#8a8f98]" />
                        <span className="truncate font-mono text-xs font-medium text-[#d0d6e0]">
                          {item.name}
                        </span>
                        <Badge
                          variant="outline"
                          className="shrink-0 font-mono text-[10px]"
                        >
                          {formatBytes(item.sizeBytes)}
                        </Badge>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button asChild variant="ghost" size="xs">
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
                        <Button asChild variant="outline" size="xs">
                          <Link
                            href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.path)}`}
                            title={`Open in Archive Explorer: ${item.archiveFilename}`}
                          >
                            <ArrowUpRight className="size-3" />
                          </Link>
                        </Button>
                      </div>
                    </div>

                    {/* Clickable Path forward to Archive Explorer */}
                    <Link
                      href={`/archives/${item.archiveId}?path=${encodeURIComponent(item.path)}`}
                      className="group inline-flex items-center gap-1 truncate font-mono text-[11px] text-[#62666d] hover:text-[#d0d6e0] hover:underline"
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
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          {selectedResult === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-[#62666d]" />
              <p className="text-[13.5px] font-medium text-[#d0d6e0]">
                Select any file to inspect
              </p>
              <p className="max-w-xs text-xs text-[#8a8f98]">
                Files are streamed directly from archive volumes in memory without disk extraction.
              </p>
            </div>
          ) : (
            <>
              {/* File Viewer Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-[#d0d6e0]">
                      {selectedResult.name}
                    </span>
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {formatBytes(selectedResult.sizeBytes)}
                    </Badge>
                  </div>
                  <Link
                    href={`/archives/${selectedResult.archiveId}?path=${encodeURIComponent(selectedResult.path)}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-[#62666d] hover:text-[#d0d6e0] hover:underline"
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
                      >
                        <WrapText className="size-3" />
                        {wrapLines ? "Wrapped" : "No wrap"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
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

                  <Button asChild variant="outline" size="xs">
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
                  <Button asChild variant="outline" size="xs">
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
                  <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8a8f98]">
                    <Loader2 className="size-4 animate-spin" />
                    Streaming {selectedResult.name}…
                  </div>
                ) : fileError ? (
                  <div className="flex flex-col gap-2 rounded-[6px] border border-[rgba(249,24,128,0.3)] bg-[rgba(249,24,128,0.08)] p-4 text-[13px] text-[#d0d6e0]">
                    <div className="flex items-center gap-2 font-medium text-[#f91880]">
                      <AlertCircle className="size-4 shrink-0" />
                      <span>Cannot preview file</span>
                    </div>
                    <p className="text-xs leading-relaxed text-[#d0d6e0]">
                      {fileError}
                    </p>
                  </div>
                ) : preview?.kind === "image" && preview.base64Data ? (
                  <div className="flex items-center justify-center p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${preview.mimeType};base64,${preview.base64Data}`}
                      alt={selectedResult.name}
                      className="max-h-[480px] rounded-[6px] border border-[rgba(255,255,255,0.08)] object-contain"
                    />
                  </div>
                ) : preview?.kind === "text" ? (
                  <CodeViewer
                    content={preview.text ?? ""}
                    filename={selectedResult.name}
                    wrapLines={wrapLines}
                  />
                ) : preview?.kind === "binary" ? (
                  <pre className="overflow-x-auto rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[#08090a] p-3 font-mono text-xs leading-[19px] text-[#d0d6e0]">
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
        }}
      >
        <DialogContent className="border-[rgba(255,255,255,0.08)] bg-[#0f1011] text-[#f7f8f8] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base text-[#ffffff]">
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
                        : "bg-[#4e525a]",
                  )}
                  style={{ width: `${downloadJob?.percent ?? 0}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.02)] p-2.5 text-xs">
              <div className="flex items-center gap-2">
                {downloadJob?.status === "preparing" ? (
                  <Loader2 className="size-3.5 animate-spin text-[#8a8f98]" />
                ) : (
                  <FileArchive className="size-3.5 text-[#8a8f98]" />
                )}
                <span className="font-mono text-[#d0d6e0]">
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
