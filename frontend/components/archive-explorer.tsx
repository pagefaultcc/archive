"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerLeftUp,
  Download,
  FileArchive,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  Search,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeViewer } from "@/components/code-viewer";
import { copyToClipboard } from "@/lib/utils";
import {
  archiveDownloadUrl,
  browserGetArchive,
  browserPreviewArchiveFile,
} from "@/lib/api";
import type {
  ArchiveDetail,
  ArchiveEntry,
  ArchiveFilePreview,
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

export function ArchiveExplorer({
  initialDetail,
  initialFilePath,
}: {
  initialDetail: ArchiveDetail;
  initialFilePath?: string;
}) {
  const archive = initialDetail.archive;
  const [currentParent, setCurrentParent] = useState(initialDetail.parentPath);
  const [entries, setEntries] = useState<ArchiveEntry[]>(initialDetail.entries);
  const [isLoadingDir, setIsLoadingDir] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const [treeDirs, setTreeDirs] = useState<Record<string, ArchiveEntry[]>>(() => ({
    "": initialDetail.entries.filter((e) => e.isDir),
  }));
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    "": true,
  });
  const [loadingTreeFolder, setLoadingTreeFolder] = useState<
    Record<string, boolean>
  >({});

  const [selectedFile, setSelectedFile] = useState<ArchiveEntry | null>(null);
  const [preview, setPreview] = useState<ArchiveFilePreview | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const [copied, setCopied] = useState(false);

  const searchTimerRef = useRef<number | undefined>(undefined);
  const dirRequestRef = useRef(0);
  const fileRequestRef = useRef(0);

  const openFilePreview = useCallback(
    async (entry: ArchiveEntry) => {
      if (entry.isDir) return;
      const reqId = ++fileRequestRef.current;
      setSelectedFile(entry);
      setIsLoadingFile(true);
      setFileError(null);
      const res = await browserPreviewArchiveFile(archive.id, entry.path);
      if (reqId !== fileRequestRef.current) return;
      setIsLoadingFile(false);
      if (!res.ok) {
        setPreview(null);
        setFileError(res.error?.message ?? "Failed to read file from archive.");
        return;
      }
      setPreview(res.data);
    },
    [archive.id],
  );

  const navigateFolder = useCallback(
    async (folderPath: string, query = "") => {
      const reqId = ++dirRequestRef.current;
      setIsLoadingDir(true);
      const res = await browserGetArchive(archive.id, {
        parent: folderPath,
        q: query.trim() || undefined,
      });
      if (reqId !== dirRequestRef.current) return;
      setIsLoadingDir(false);
      if (!res.ok) {
        toast.error(res.error?.message ?? "Failed to load directory.");
        return;
      }
      setCurrentParent(folderPath);
      setEntries(res.data.entries);
      if (!query.trim()) {
        setTreeDirs((prev) => ({
          ...prev,
          [folderPath]: res.data.entries.filter((e) => e.isDir),
        }));
        if (folderPath) {
          const parts = folderPath.split("/");
          const nextExpanded: Record<string, boolean> = { "": true };
          let acc = "";
          for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            nextExpanded[acc] = true;
          }
          setExpandedFolders((prev) => ({ ...prev, ...nextExpanded }));
        }
      }
    },
    [archive.id],
  );

  const toggleTreeFolder = useCallback(
    async (folderPath: string) => {
      const currentlyOpen = Boolean(expandedFolders[folderPath]);
      setExpandedFolders((prev) => ({
        ...prev,
        [folderPath]: !currentlyOpen,
      }));
      if (!currentlyOpen && treeDirs[folderPath] === undefined) {
        setLoadingTreeFolder((prev) => ({ ...prev, [folderPath]: true }));
        const res = await browserGetArchive(archive.id, { parent: folderPath });
        setLoadingTreeFolder((prev) => ({ ...prev, [folderPath]: false }));
        if (res.ok) {
          setTreeDirs((prev) => ({
            ...prev,
            [folderPath]: res.data.entries.filter((e) => e.isDir),
          }));
        }
      }
      void navigateFolder(folderPath, "");
      setSearchQuery("");
    },
    [archive.id, expandedFolders, navigateFolder, treeDirs],
  );

  useEffect(() => {
    if (initialFilePath) {
      const lastSlash = initialFilePath.lastIndexOf("/");
      const parentDir = lastSlash >= 0 ? initialFilePath.slice(0, lastSlash) : "";
      const baseName =
        lastSlash >= 0 ? initialFilePath.slice(lastSlash + 1) : initialFilePath;
      void navigateFolder(parentDir, "");
      void openFilePreview({
        id: 0,
        path: initialFilePath,
        parentPath: parentDir,
        name: baseName,
        isDir: false,
        sizeBytes: 0,
        packedBytes: 0,
        crc32: "",
        encrypted: false,
        modifiedAt: null,
      });
    } else {
      const firstFile = initialDetail.entries.find((e) => !e.isDir);
      if (firstFile) {
        void openFilePreview(firstFile);
      }
    }
    return () => {
      clearTimeout(searchTimerRef.current ?? undefined);
    };
  }, [initialDetail.entries, initialFilePath, navigateFolder, openFilePreview]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    clearTimeout(searchTimerRef.current ?? undefined);
    searchTimerRef.current = window.setTimeout(() => {
      void navigateFolder(currentParent, val);
    }, 220);
  };

  const breadcrumbs = useMemo(() => {
    if (!currentParent) return [];
    const parts = currentParent.split("/").filter(Boolean);
    return parts.map((segment, idx) => ({
      label: segment,
      path: parts.slice(0, idx + 1).join("/"),
    }));
  }, [currentParent]);

  const parentFolderOfCurrent = useMemo(() => {
    if (!currentParent) return null;
    const i = currentParent.lastIndexOf("/");
    return i >= 0 ? currentParent.slice(0, i) : "";
  }, [currentParent]);

  const renderTreeBranch = (parentPath: string, depth: number) => {
    const dirs = treeDirs[parentPath] ?? [];
    if (dirs.length === 0) return null;
    return (
      <ul className="space-y-0.5">
        {dirs.map((dir) => {
          const isOpen = Boolean(expandedFolders[dir.path]);
          const isActive = currentParent === dir.path && !searchQuery.trim();
          const isLoading = Boolean(loadingTreeFolder[dir.path]);
          return (
            <li key={dir.path}>
              <div
                className={cn(
                  "group flex items-center justify-between gap-1 rounded-md pr-1.5 transition-none",
                  isActive
                    ? "bg-white/[0.07] text-[#f3f4f6]"
                    : "text-[#8b909a] hover:bg-white/[0.03] hover:text-[#e5e7eb]",
                )}
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
              >
                <button
                  type="button"
                  onClick={() => void toggleTreeFolder(dir.path)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs cursor-pointer"
                >
                  {isLoading ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-[#5c606a]" />
                  ) : isOpen ? (
                    <ChevronDown className="size-3 shrink-0 text-[#5c606a]" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-[#5c606a]" />
                  )}
                  {isOpen ? (
                    <FolderOpen className="size-3.5 shrink-0 text-[#e5e7eb]" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-[#8b909a]" />
                  )}
                  <span className="truncate font-medium">{dir.name}</span>
                </button>
                <a
                  href={archiveDownloadUrl(archive.id, dir.path, true)}
                  download
                  title={`Download ${dir.name}.zip`}
                  aria-label={`Download ${dir.name} folder as zip`}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded text-[#6b707b] opacity-0 transition-none hover:bg-white/[0.08] hover:text-white group-hover:opacity-100"
                >
                  <Download className="size-3" />
                </a>
              </div>
              {isOpen ? renderTreeBranch(dir.path, depth + 1) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      {/* Container Header Bar */}
      <section className="obsidian-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-md border-white/[0.08] bg-[#101216] px-2.5 text-xs text-[#c8ccd4] hover:text-white"
            >
              <Link href="/archives">
                <ArrowLeft className="size-3.5" />
                Back
              </Link>
            </Button>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1
                  className="truncate text-sm font-semibold text-[#f3f4f6]"
                  title={archive.filename}
                >
                  {archive.filename}
                </h1>
                <span className="obsidian-pill font-mono text-[10px] uppercase">
                  {archive.format}
                </span>
                {archive.isEncrypted ? (
                  <span className="obsidian-badge-active gap-1 text-[10px]">
                    <Lock className="size-2.5 text-[#10b981]" />
                    Unlocked
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-[#6b707b]">
                {archive.fileCount.toLocaleString()} files ·{" "}
                {archive.dirCount.toLocaleString()} dirs ·{" "}
                {formatBytes(archive.sizeBytes)} packed →{" "}
                {formatBytes(archive.uncompressedBytes)} raw · sha256:
                {archive.sha256.slice(0, 12)}
              </p>
            </div>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#6b707b]" />
            <input
              type="search"
              placeholder="Filter entries in container…"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="obsidian-input h-8 w-full pl-8 pr-3 text-xs"
            />
          </div>
        </div>
      </section>

      {/* 3-Pane Obsidian Inspector */}
      <div className="grid min-h-[640px] grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Pane 1: Directory Tree */}
        <aside className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          <div className="border-b border-white/[0.06] bg-[#101216]/60 px-3.5 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6b707b]">
              Directories ({archive.dirCount})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2.5">
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                void navigateFolder("", "");
              }}
              className={cn(
                "mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium transition-none cursor-pointer",
                currentParent === "" && !searchQuery.trim()
                  ? "bg-white/[0.07] text-[#f3f4f6]"
                  : "text-[#8b909a] hover:bg-white/[0.03] hover:text-[#e5e7eb]",
              )}
            >
              <FolderOpen className="size-3.5 shrink-0 text-[#e5e7eb]" />
              <span className="truncate">/ (Root)</span>
            </button>
            {renderTreeBranch("", 1)}
          </div>
        </aside>

        {/* Pane 2: Folder Entries */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-[#101216]/60 px-3.5 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  void navigateFolder("", "");
                }}
                className={cn(
                  "rounded px-1.5 py-0.5 transition-none hover:bg-white/[0.05] cursor-pointer",
                  currentParent === "" && !searchQuery.trim()
                    ? "font-semibold text-[#f3f4f6]"
                    : "text-[#8b909a]",
                )}
              >
                Root
              </button>
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <span
                    key={crumb.path}
                    className="inline-flex min-w-0 items-center gap-1"
                  >
                    <span className="text-[#5c606a]">/</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        void navigateFolder(crumb.path, "");
                      }}
                      className={cn(
                        "max-w-[16ch] truncate rounded px-1.5 py-0.5 transition-none hover:bg-white/[0.05] cursor-pointer",
                        isLast && !searchQuery.trim()
                          ? "font-semibold text-[#f3f4f6]"
                          : "text-[#8b909a]",
                      )}
                    >
                      {crumb.label}
                    </button>
                  </span>
                );
              })}
              {searchQuery.trim() ? (
                <span className="obsidian-pill ml-1 font-mono text-[10px]">
                  Filter: &ldquo;{searchQuery.trim()}&rdquo;
                </span>
              ) : null}
            </div>

            {currentParent ? (
              <Button
                asChild
                variant="outline"
                size="xs"
                className="h-6 gap-1 rounded border-white/[0.08] bg-[#101216] text-[11px]"
              >
                <a
                  href={archiveDownloadUrl(archive.id, currentParent, true)}
                  download
                >
                  <FileArchive className="size-3" />
                  Folder .zip
                </a>
              </Button>
            ) : null}
          </div>

          <div className="flex-1 divide-y divide-white/[0.04] overflow-y-auto">
            {parentFolderOfCurrent !== null && !searchQuery.trim() ? (
              <button
                type="button"
                onClick={() => void navigateFolder(parentFolderOfCurrent, "")}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs text-[#8b909a] transition-none hover:bg-white/[0.025] hover:text-[#f3f4f6] cursor-pointer"
              >
                <CornerLeftUp className="size-3.5 shrink-0 text-[#5c606a]" />
                <span className="font-mono">..</span>
                <span className="text-[11px] text-[#6b707b]">Parent directory</span>
              </button>
            ) : null}

            {isLoadingDir ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
                <Loader2 className="size-4 animate-spin" />
                Loading directory…
              </div>
            ) : entries.length === 0 ? (
              <div className="px-4 py-12 text-center text-xs text-[#6b707b]">
                {searchQuery.trim()
                  ? `No entries match "${searchQuery.trim()}".`
                  : "This directory is empty."}
              </div>
            ) : (
              entries.map((entry) => {
                const isSelected = selectedFile?.path === entry.path;
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      "group flex items-center justify-between gap-2 px-3.5 py-2 transition-none",
                      isSelected
                        ? "bg-white/[0.06]"
                        : "hover:bg-white/[0.02]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (entry.isDir) {
                          setSearchQuery("");
                          void navigateFolder(entry.path, "");
                        } else {
                          void openFilePreview(entry);
                        }
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer"
                    >
                      {entry.isDir ? (
                        <Folder className="size-3.5 shrink-0 text-[#e5e7eb]" />
                      ) : (
                        <FileText className="size-3.5 shrink-0 text-[#8b909a]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="truncate text-xs font-medium text-[#f3f4f6]"
                            title={entry.name}
                          >
                            {entry.name}
                          </span>
                          {entry.encrypted ? (
                            <Lock
                              aria-label="Encrypted entry"
                              className="size-3 shrink-0 text-[#6b707b]"
                            />
                          ) : null}
                        </div>
                        <p className="truncate font-mono text-[10.5px] text-[#6b707b]">
                          {searchQuery.trim()
                            ? entry.path
                            : entry.isDir
                              ? "Directory"
                              : `${formatBytes(entry.sizeBytes)}${entry.crc32 ? ` · ${entry.crc32}` : ""}`}
                        </p>
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      {entry.isDir ? (
                        <Button
                          asChild
                          variant="outline"
                          size="xs"
                          className="h-6 gap-1 rounded border-white/[0.08] bg-[#101216] px-2 text-[11px]"
                        >
                          <a
                            href={archiveDownloadUrl(archive.id, entry.path, true)}
                            download
                          >
                            <Download className="size-3" />
                            .zip
                          </a>
                        </Button>
                      ) : (
                        <>
                          <Button
                            asChild
                            variant="ghost"
                            size="xs"
                            className="h-6 px-2 text-[11px] text-[#8b909a] hover:text-white"
                          >
                            <a
                              href={archiveDownloadUrl(
                                archive.id,
                                entry.path,
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
                                archive.id,
                                entry.path,
                                true,
                              )}
                              download
                            >
                              <FileArchive className="size-3" />
                              .zip
                            </a>
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Pane 3: In-Memory File Preview */}
        <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
          {selectedFile === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-[#5c606a]" />
              <p className="text-xs font-medium text-[#e5e7eb]">
                Select a file to inspect
              </p>
              <p className="max-w-xs text-[11px] text-[#6b707b]">
                Files stream directly into memory without extracting the archive to disk.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-[#101216]/60 px-3.5 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="truncate font-mono text-xs font-semibold text-[#f3f4f6]"
                      title={selectedFile.name}
                    >
                      {selectedFile.name}
                    </span>
                    <span className="obsidian-pill font-mono text-[10px]">
                      {formatBytes(selectedFile.sizeBytes)}
                    </span>
                    {preview?.truncated ? (
                      <span className="obsidian-pill text-[10px]">
                        First 512 KiB
                      </span>
                    ) : null}
                  </div>
                  <p
                    className="truncate font-mono text-[10.5px] text-[#6b707b]"
                    title={selectedFile.path}
                  >
                    {selectedFile.path}
                  </p>
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
                        onClick={async () => {
                          const ok = await copyToClipboard(preview.text ?? "");
                          if (ok) {
                            setCopied(true);
                            toast.success(`Copied ${selectedFile.name}`);
                            setTimeout(() => setCopied(false), 1500);
                          } else {
                            toast.error("Failed to copy to clipboard.");
                          }
                        }}
                        className="h-6 gap-1 px-2 text-[11px] text-[#8b909a] hover:text-white"
                      >
                        {copied ? (
                          <Check className="size-3 text-[#10b981]" />
                        ) : (
                          <Copy className="size-3" />
                        )}
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
                        archive.id,
                        selectedFile.path,
                        false,
                      )}
                      download
                    >
                      <Download className="size-3" />
                      Download
                    </a>
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-3">
                {isLoadingFile ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#8b909a]">
                    <Loader2 className="size-4 animate-spin" />
                    Streaming {selectedFile.name}…
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
                    {/* eslint-disable-next-line @next/next/no-img-element -- inline archive stream preview */}
                    <img
                      src={`data:${preview.mimeType};base64,${preview.base64Data}`}
                      alt={selectedFile.name}
                      className="max-h-[480px] rounded-md border border-white/[0.08] object-contain"
                    />
                  </div>
                ) : preview?.kind === "text" ? (
                  <CodeViewer
                    content={preview.text ?? ""}
                    filename={selectedFile.name}
                    wrapLines={wrapLines}
                  />
                ) : preview?.kind === "binary" ? (
                  <div className="space-y-2">
                    <p className="text-xs text-[#8b909a]">
                      Binary payload ({preview.mimeType}) — 4 KiB hex dump:
                    </p>
                    <pre className="overflow-x-auto rounded-md border border-white/[0.06] bg-[#08090b] p-3 font-mono text-xs leading-5 text-[#c8ccd4]">
                      {preview.hexPreview}
                    </pre>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
