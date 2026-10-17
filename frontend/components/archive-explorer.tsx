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
  Download,
  FileArchive,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  CornerLeftUp,
  Loader2,
  Lock,
  Search,
  WrapText,
} from "lucide-react";
import { Icon3D } from "@/components/kinetics-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  // Folder tree cache: parentPath -> child directory entries
  const [treeDirs, setTreeDirs] = useState<Record<string, ArchiveEntry[]>>(() => ({
    "": initialDetail.entries.filter((e) => e.isDir),
  }));
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    "": true,
  });
  const [loadingTreeFolder, setLoadingTreeFolder] = useState<
    Record<string, boolean>
  >({});

  // Selected file preview state
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
        // Expand ancestor folders in tree
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

  // Auto-open initialFilePath if specified, otherwise the first file in the root directory
  useEffect(() => {
    if (initialFilePath) {
      const lastSlash = initialFilePath.lastIndexOf("/");
      const parentDir = lastSlash >= 0 ? initialFilePath.slice(0, lastSlash) : "";
      const baseName = lastSlash >= 0 ? initialFilePath.slice(lastSlash + 1) : initialFilePath;
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
                  "group flex items-center justify-between gap-1 rounded-[6px] pr-1.5 transition-none",
                  isActive
                    ? "bg-[rgba(255,255,255,0.08)] text-[#ffffff]"
                    : "text-[#8a8f98] hover:bg-[rgba(255,255,255,0.04)] hover:text-[#f7f8f8]",
                )}
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
              >
                <button
                  type="button"
                  onClick={() => void toggleTreeFolder(dir.path)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-[13px]"
                >
                  {isLoading ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-[#62666d]" />
                  ) : isOpen ? (
                    <ChevronDown className="size-3.5 shrink-0 text-[#62666d]" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-[#62666d]" />
                  )}
                  {isOpen ? (
                    <FolderOpen className="size-3.5 shrink-0 text-[#f7f8f8]" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-[#8a8f98]" />
                  )}
                  <span className="truncate font-[510]">{dir.name}</span>
                </button>
                <a
                  href={archiveDownloadUrl(archive.id, dir.path, true)}
                  download
                  title={`Download ${dir.name}.zip (auto-deleted from /tmp)`}
                  aria-label={`Download ${dir.name} folder as zip`}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[#8a8f98] opacity-75 transition-opacity hover:bg-[rgba(255,255,255,0.08)] hover:text-[#ffffff] group-hover:opacity-100"
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

  const textLines = useMemo(() => {
    if (preview?.kind !== "text" || preview.text === undefined) return [];
    return preview.text.split("\n");
  }, [preview]);

  return (
    <div className="flex flex-1 flex-col gap-4 spring-enter">
      {/* Top Explorer Header Bar */}
      <section className="flex flex-col gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Button asChild variant="outline" size="sm">
              <Link href="/archives">
                <ArrowLeft className="size-3.5" />
                Archives
              </Link>
            </Button>
            <Icon3D
              name={archive.isEncrypted ? "lock" : "tools"}
              size="sm"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-[16px] font-[590] text-[#ffffff]">
                  {archive.filename}
                </h1>
                <Badge variant="outline" className="uppercase font-mono">
                  {archive.format}
                </Badge>
                {archive.isEncrypted ? (
                  <Badge variant="secondary">
                    <Lock className="size-3" />
                    Password Stored · Indexed
                  </Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-[12px] text-[#8a8f98]">
                {archive.fileCount.toLocaleString()} files ·{" "}
                {archive.dirCount.toLocaleString()} folders ·{" "}
                {formatBytes(archive.sizeBytes)} packed →{" "}
                {formatBytes(archive.uncompressedBytes)} uncompressed ·{" "}
                <span className="font-mono text-[#62666d]">
                  sha256:{archive.sha256.slice(0, 12)}…
                </span>
              </p>
            </div>
          </div>

          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#62666d]" />
            <Input
              type="search"
              placeholder="Search all files & folders in archive…"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-9 rounded-full pl-8 text-[13px]"
            />
          </div>
        </div>
      </section>

      {/* 3-Pane File Explorer Grid */}
      <div className="grid min-h-[640px] grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1.05fr)_minmax(0,1.15fr)]">
        {/* Pane 1: Folder Tree Sidebar */}
        <aside className="flex flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-3">
          <div className="mb-2 flex items-center justify-between px-1.5">
            <span className="text-[11px] font-[510] uppercase tracking-wider text-[#62666d]">
              Folders ({archive.dirCount})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto pr-1">
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                void navigateFolder("", "");
              }}
              className={cn(
                "mb-1 flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] font-[510] transition-none",
                currentParent === "" && !searchQuery.trim()
                  ? "bg-[rgba(255,255,255,0.08)] text-[#ffffff]"
                  : "text-[#8a8f98] hover:bg-[rgba(255,255,255,0.04)] hover:text-[#f7f8f8]",
              )}
            >
              <FolderOpen className="size-3.5 shrink-0 text-[#f7f8f8]" />
              <span className="truncate">/ (Root)</span>
            </button>
            {renderTreeBranch("", 1)}
          </div>
        </aside>

        {/* Pane 2: Directory Contents & Search List */}
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          {/* Breadcrumb & Current Folder Download Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] px-3.5 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-[13px]">
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  void navigateFolder("", "");
                }}
                className={cn(
                  "rounded-full px-2 py-0.5 transition-colors hover:bg-[rgba(255,255,255,0.05)]",
                  currentParent === "" && !searchQuery.trim()
                    ? "font-[590] text-[#ffffff]"
                    : "text-[#8a8f98]",
                )}
              >
                Root
              </button>
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <span key={crumb.path} className="inline-flex items-center gap-1">
                    <span className="text-[#62666d]">/</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        void navigateFolder(crumb.path, "");
                      }}
                      className={cn(
                        "max-w-[16ch] truncate rounded-full px-2 py-0.5 transition-colors hover:bg-[rgba(255,255,255,0.05)]",
                        isLast && !searchQuery.trim()
                          ? "font-[590] text-[#ffffff]"
                          : "text-[#8a8f98]",
                      )}
                    >
                      {crumb.label}
                    </button>
                  </span>
                );
              })}
              {searchQuery.trim() ? (
                <Badge variant="secondary" className="ml-1">
                  Search: “{searchQuery.trim()}”
                </Badge>
              ) : null}
            </div>

            {currentParent ? (
              <Button asChild variant="outline" size="xs">
                <a
                  href={archiveDownloadUrl(archive.id, currentParent, true)}
                  download
                >
                  <FileArchive className="size-3" />
                  Download folder .zip
                </a>
              </Button>
            ) : null}
          </div>

          {/* Directory Entries List */}
          <div className="flex-1 overflow-y-auto divide-y divide-[rgba(255,255,255,0.04)]">
            {parentFolderOfCurrent !== null && !searchQuery.trim() ? (
              <button
                type="button"
                onClick={() => void navigateFolder(parentFolderOfCurrent, "")}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-[#8a8f98] transition-colors hover:bg-[rgba(255,255,255,0.03)] hover:text-[#f7f8f8]"
              >
                <CornerLeftUp className="size-3.5 shrink-0 text-[#62666d]" />
                <span className="font-mono">..</span>
                <span className="text-[12px] text-[#62666d]">Parent folder</span>
              </button>
            ) : null}

            {isLoadingDir ? (
              <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[#8a8f98]">
                <Loader2 className="size-4 animate-spin" />
                Loading indexed directory…
              </div>
            ) : entries.length === 0 ? (
              <div className="py-12 text-center text-[13px] text-[#8a8f98]">
                {searchQuery.trim()
                  ? `No indexed entries match “${searchQuery.trim()}”.`
                  : "This directory is empty."}
              </div>
            ) : (
              entries.map((entry) => {
                const isSelected = selectedFile?.path === entry.path;
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      "group flex items-center justify-between gap-2 px-3.5 py-2 transition-colors",
                      isSelected
                        ? "bg-[rgba(255,255,255,0.07)]"
                        : "hover:bg-[rgba(255,255,255,0.03)]",
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
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      {entry.isDir ? (
                        <Folder className="size-4 shrink-0 text-[#f7f8f8]" />
                      ) : (
                        <FileText className="size-4 shrink-0 text-[#8a8f98]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-[510] text-[#f7f8f8]">
                            {entry.name}
                          </span>
                          {entry.encrypted ? (
                            <Lock
                              aria-label="Encrypted entry"
                              className="size-3 shrink-0 text-[#62666d]"
                            />
                          ) : null}
                        </div>
                        {searchQuery.trim() || entry.crc32 ? (
                          <p className="truncate font-mono text-[11px] text-[#62666d]">
                            {searchQuery.trim()
                              ? entry.path
                              : entry.isDir
                                ? "Folder"
                                : `${formatBytes(entry.sizeBytes)} · CRC32 ${entry.crc32}`}
                          </p>
                        ) : null}
                      </div>
                    </button>

                    {/* Per-entry Download Controls (both Folders and Files) */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {entry.isDir ? (
                        <Button asChild variant="outline" size="xs">
                          <a
                            href={archiveDownloadUrl(
                              archive.id,
                              entry.path,
                              true,
                            )}
                            download
                            title={`Pack ${entry.name} into .zip and download (auto-deleted from /tmp)`}
                          >
                            <Download className="size-3" />
                            .zip
                          </a>
                        </Button>
                      ) : (
                        <>
                          <Button asChild variant="ghost" size="xs">
                            <a
                              href={archiveDownloadUrl(
                                archive.id,
                                entry.path,
                                false,
                              )}
                              download
                              title={`Download ${entry.name} (staged in /tmp & auto-deleted)`}
                            >
                              <Download className="size-3" />
                              File
                            </a>
                          </Button>
                          <Button asChild variant="outline" size="xs">
                            <a
                              href={archiveDownloadUrl(
                                archive.id,
                                entry.path,
                                true,
                              )}
                              download
                              title={`Download ${entry.name} packed as .zip (auto-deleted from /tmp)`}
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

        {/* Pane 3: Zero-Extraction File Viewer */}
        <section className="flex min-w-0 flex-col rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          {selectedFile === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <FileCode className="size-6 text-[#62666d]" />
              <p className="text-[14px] font-[510] text-[#f7f8f8]">
                Select any file to view its contents
              </p>
              <p className="max-w-xs text-[12px] text-[#8a8f98]">
                Files are streamed directly from the archive in memory using the
                stored password — never extracted to disk.
              </p>
            </div>
          ) : (
            <>
              {/* File Viewer Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-[590] text-[#ffffff]">
                      {selectedFile.name}
                    </span>
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {formatBytes(selectedFile.sizeBytes)}
                    </Badge>
                    {preview?.truncated ? (
                      <Badge variant="outline">First 512 KiB preview</Badge>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-[11px] text-[#62666d]">
                    {selectedFile.path}
                    {selectedFile.crc32 ? ` · CRC32 ${selectedFile.crc32}` : ""}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {preview?.kind === "text" && preview.text !== undefined ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setWrapLines((w) => !w)}
                        title="Toggle line wrap"
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
                            setCopied(true);
                            toast.success(`Copied ${selectedFile.name}`);
                            setTimeout(() => setCopied(false), 1500);
                          } else {
                            toast.error("Failed to copy to clipboard.");
                          }
                        }}
                      >
                        {copied ? (
                          <Check className="size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                        Copy
                      </Button>
                    </>
                  ) : null}
                  <Button asChild variant="outline" size="xs">
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
                  <Button asChild variant="outline" size="xs">
                    <a
                      href={archiveDownloadUrl(
                        archive.id,
                        selectedFile.path,
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
              <div className="flex-1 overflow-auto p-3.5">
                {isLoadingFile ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[#8a8f98]">
                    <Loader2 className="size-4 animate-spin" />
                    Reading {selectedFile.name} from archive…
                  </div>
                ) : fileError ? (
                  <div className="flex flex-col gap-2 rounded-[6px] border border-[rgba(249,24,128,0.3)] bg-[rgba(249,24,128,0.08)] p-4 text-[13px] text-[#ffffff]">
                    <div className="flex items-center gap-2 font-medium text-[#f91880]">
                      <AlertCircle className="size-4 shrink-0" />
                      <span>Cannot preview file</span>
                    </div>
                    <p className="text-[12.5px] leading-relaxed text-[#d0d6e0]">
                      {fileError}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button asChild variant="outline" size="xs">
                        <a
                          href={archiveDownloadUrl(archive.id, selectedFile.path, false)}
                          download
                        >
                          <Download className="size-3" />
                          Direct file download
                        </a>
                      </Button>
                      <Button asChild variant="outline" size="xs">
                        <a
                          href={archiveDownloadUrl(archive.id, selectedFile.path, true)}
                          download
                        >
                          <FileArchive className="size-3" />
                          Download as .zip
                        </a>
                      </Button>
                    </div>
                  </div>
                ) : preview?.kind === "image" && preview.base64Data ? (
                  <div className="flex items-center justify-center p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element -- inline archive stream preview */}
                    <img
                      src={`data:${preview.mimeType};base64,${preview.base64Data}`}
                      alt={selectedFile.name}
                      className="max-h-[480px] rounded-[6px] border border-[rgba(255,255,255,0.08)] object-contain"
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
                    <p className="text-[12px] text-[#8a8f98]">
                      Binary file ({preview.mimeType}) — showing first 4 KiB hex
                      inspector:
                    </p>
                    <pre className="overflow-x-auto rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[#08090a] p-3 font-mono text-[12px] leading-[19px] text-[#d0d6e0]">
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
