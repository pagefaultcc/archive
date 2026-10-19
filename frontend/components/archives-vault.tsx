"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Archive,
  ArrowUpRight,
  CheckSquare,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FileText,
  HardDrive,
  Loader2,
  Lock,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  browserClearChannelBlacklist,
  browserClearTelegramQueue,
  browserDeleteArchive,
  browserEnqueueTelegramBatch,
  browserGetTelegramQueue,
  browserListChannels,
  browserReindexAllArchives,
  browserReindexArchive,
  browserScrapeChannel,
  browserUnlockArchive,
  browserUploadArchiveWithProgress,
} from "@/lib/api";
import type {
  ArchiveFormat,
  ArchiveItem,
  ScrapedMessageItem,
  SessionUser,
  TelegramChannelItem,
  TelegramQueueStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;

type UploadItem = {
  id: string;
  filename: string;
  format: ArchiveFormat | null;
  loaded: number;
  total: number;
  percent: number;
  stage: "queued" | "uploading" | "indexing" | "done" | "error";
  error?: string;
  startedAt?: number;
  mbps?: number;
  etaSeconds?: number;
};

export type ScrapeDownloadItem = {
  id: string;
  jobId?: string;
  channelId: string;
  messageId: number;
  filename: string;
  sizeBytes: number;
  format: string;
  password?: string;
  stage: "queued" | "downloading" | "indexing" | "done" | "skipped" | "error";
  statusText?: string;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  speedMbps: number;
  etaSeconds: number;
  error?: string;
};

const STAGE_LABELS: Record<UploadItem["stage"], string> = {
  queued: "Queued…",
  uploading: "Streaming bytes…",
  indexing: "Detecting encryption & indexing…",
  done: "Indexed",
  error: "Failed",
};

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

function formatEta(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const s = Math.ceil(seconds);
  if (s < 60) {
    return `${s}s left`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) {
    return rem > 0 ? `${m}m ${rem}s left` : `${m}m left`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m left`;
}

function formatOf(filename: string): ArchiveFormat | null {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".7z")) return "7z";
  if (lower.endsWith(".rar")) return "rar";
  return null;
}

export function ArchivesVault({
  initialArchives,
}: {
  initialArchives: ArchiveItem[];
  currentUser?: SessionUser;
}) {
  const router = useRouter();
  const [archives, setArchives] = useState<ArchiveItem[]>(initialArchives);
  useEffect(() => {
    queueMicrotask(() => {
      setArchives(initialArchives);
    });
  }, [initialArchives]);

  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const isUploading = uploadQueue.some(
    (item) =>
      item.stage === "uploading" ||
      item.stage === "indexing" ||
      item.stage === "queued",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [unlockArchive, setUnlockArchive] = useState<ArchiveItem | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [showUnlockPassword, setShowUnlockPassword] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isDeletingId] = useState<string | null>(null);
  const [isReindexingAll, setIsReindexingAll] = useState(false);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const [archiveSearchQuery, setArchiveSearchQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<string>("all");

  // Auto-Scrape state
  const [isAutoScrapeOpen, setIsAutoScrapeOpen] = useState(false);
  const [scrapeChannels, setScrapeChannels] = useState<TelegramChannelItem[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [scrapeLimit, setScrapeLimit] = useState(100);
  const [isScanningChannel, setIsScanningChannel] = useState(false);
  const [scrapedItems, setScrapedItems] = useState<ScrapedMessageItem[]>([]);
  const [selectedMsgMap, setSelectedMsgMap] = useState<Record<number, boolean>>({});
  const [passwordOverrideMap, setPasswordOverrideMap] = useState<Record<number, string>>({});
  const [isImportingScraped, setIsImportingScraped] = useState(false);
  const [serverQueue, setServerQueue] = useState<TelegramQueueStatus | null>(null);

  const totalArchives = archives.length;
  const indexedFiles = archives.reduce((sum, a) => sum + a.fileCount, 0);
  const indexedDirs = archives.reduce((sum, a) => sum + a.dirCount, 0);
  const encryptedVaults = archives.filter((a) => a.isEncrypted).length;
  const totalIndexedBytes = archives.reduce((sum, a) => sum + a.uncompressedBytes, 0);
  const totalPackedBytes = archives.reduce((sum, a) => sum + a.sizeBytes, 0);

  const uploadSingle = useCallback(
    async (file: File, itemId: string): Promise<ArchiveItem | null> => {
      const format = formatOf(file.name);
      if (format === null) {
        setUploadQueue((prev) =>
          prev.map((it) =>
            it.id === itemId
              ? {
                  ...it,
                  stage: "error",
                  error: "Unsupported format. Use .zip, .7z, or .rar.",
                }
              : it,
          ),
        );
        return null;
      }
      if (file.size > MAX_ARCHIVE_BYTES) {
        setUploadQueue((prev) =>
          prev.map((it) =>
            it.id === itemId
              ? { ...it, stage: "error", error: "Exceeds 100 GB limit." }
              : it,
          ),
        );
        return null;
      }

      const startTime = performance.now();
      setUploadQueue((prev) =>
        prev.map((it) =>
          it.id === itemId
            ? {
                ...it,
                stage: "uploading",
                percent: 0,
                startedAt: startTime,
                mbps: 0,
                etaSeconds: undefined,
              }
            : it,
        ),
      );

      const result = await browserUploadArchiveWithProgress({
        file,
        onProgress: (p) => {
          const elapsedSec = Math.max(0.1, (performance.now() - startTime) / 1000);
          const bytesPerSec = p.loaded / elapsedSec;
          const mbps = (bytesPerSec * 8) / 1_000_000;
          const remainingBytes = Math.max(0, p.total - p.loaded);
          const etaSeconds =
            bytesPerSec > 0 && remainingBytes > 0
              ? remainingBytes / bytesPerSec
              : 0;
          setUploadQueue((prev) =>
            prev.map((it) =>
              it.id === itemId
                ? {
                    ...it,
                    loaded: p.loaded,
                    total: p.total,
                    percent: p.percent,
                    stage: p.stage,
                    mbps,
                    etaSeconds,
                  }
                : it,
            ),
          );
        },
      });

      if (!result.ok) {
        const msg =
          result.error?.message ??
          (result.status === 0
            ? "Connection dropped during upload."
            : `Upload failed (HTTP ${result.status}).`);
        setUploadQueue((prev) =>
          prev.map((it) =>
            it.id === itemId ? { ...it, stage: "error", error: msg } : it,
          ),
        );
        toast.error(`"${file.name}": ${msg}`);
        return null;
      }

      const archive = result.data.archive;
      setUploadQueue((prev) =>
        prev.map((it) =>
          it.id === itemId ? { ...it, stage: "done", percent: 100 } : it,
        ),
      );

      setArchives((prev) => [
        archive,
        ...prev.filter((a) => a.id !== archive.id),
      ]);

      if (result.data.autoUnlocked) {
        toast.success(`"${archive.filename}" auto-unlocked & indexed!`);
      } else if (
        result.data.passwordRequired ||
        archive.status === "password_required"
      ) {
        toast.info(`"${archive.filename}" is password-protected.`);
        setUnlockPassword("");
        setUnlockError(null);
        setUnlockArchive(archive);
      } else {
        toast.success(`"${archive.filename}" successfully indexed.`);
      }

      return archive;
    },
    [setUnlockArchive, setUnlockError, setUnlockPassword],
  );

  const onPickFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);

      const newItems: UploadItem[] = files.map((file, idx) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${idx}`,
        filename: file.name,
        format: formatOf(file.name),
        loaded: 0,
        total: file.size || 1,
        percent: 0,
        stage: "queued",
      }));

      setUploadQueue((prev) => [...prev, ...newItems]);
      setGeneralError(null);

      let lastUploadedArchive = null as ArchiveItem | null;
      let cursor = 0;
      const worker = async () => {
        while (cursor < files.length) {
          const index = cursor++;
          const uploaded = await uploadSingle(files[index], newItems[index].id);
          if (uploaded) {
            lastUploadedArchive = uploaded as ArchiveItem;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, files.length) },
          () => worker(),
        ),
      );

      router.refresh();
      if (
        files.length === 1 &&
        lastUploadedArchive &&
        lastUploadedArchive.status === "indexed"
      ) {
        router.push(`/archives/${lastUploadedArchive.id}`);
      }
    },
    [router, uploadSingle],
  );

  const failedCount = uploadQueue.filter((it) => it.stage === "error").length;
  const finishedCount = uploadQueue.filter((it) => it.stage === "done").length;

  const handleUnlock = useCallback(async () => {
    if (unlockArchive === null || isUnlocking) return;
    setUnlockError(null);
    setIsUnlocking(true);
    const result = await browserUnlockArchive(unlockArchive.id, unlockPassword);
    if (!result.ok) {
      setIsUnlocking(false);
      setUnlockError(
        result.status === 422
          ? "Incorrect password for this encrypted archive."
          : (result.error?.message ??
              "Unlock failed. Check your connection and try again."),
      );
      return;
    }
    const unlocked = result.data.archive;
    setIsUnlocking(false);
    setArchives((prev) => [
      unlocked,
      ...prev.filter((a) => a.id !== unlocked.id),
    ]);
    toast.success("Password stored and archive indexed — opening File Explorer.");
    setUnlockArchive(null);
    setUnlockPassword("");
    router.push(`/archives/${unlocked.id}`);
  }, [isUnlocking, router, setUnlockArchive, setUnlockError, setUnlockPassword, unlockArchive, unlockPassword]);

  const handleReindexAll = useCallback(async () => {
    if (isReindexingAll) return;
    setIsReindexingAll(true);
    toast.info("Reindexing all archives…");
    const result = await browserReindexAllArchives();
    setIsReindexingAll(false);
    if (!result.ok) {
      toast.error(result.error?.message ?? "Failed to reindex archives.");
      return;
    }
    toast.success(
      `Successfully reindexed ${result.data.reindexed} of ${result.data.total} archives.`,
    );
    router.refresh();
  }, [isReindexingAll, router]);

  const handleReindexOne = useCallback(
    async (archiveId: string) => {
      if (reindexingId !== null) return;
      setReindexingId(archiveId);
      toast.info("Reindexing archive…");
      const result = await browserReindexArchive(archiveId);
      setReindexingId(null);
      if (!result.ok) {
        toast.error(result.error?.message ?? "Failed to reindex archive.");
        return;
      }
      const updated = result.data.archive;
      setArchives((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a)),
      );
      toast.success(`Reindexed ${updated.filename} (${updated.fileCount} files).`);
      router.refresh();
    },
    [reindexingId, router],
  );

  const openAutoScrapeDialog = useCallback(async () => {
    setIsAutoScrapeOpen(true);
    const res = await browserListChannels();
    if (res.ok && res.data.channels.length > 0) {
      setScrapeChannels(res.data.channels);
      setSelectedChannelId(res.data.channels[0].id);
    } else {
      setScrapeChannels([]);
    }
  }, [setIsAutoScrapeOpen, setSelectedChannelId]);

  const handleScanChannel = useCallback(async () => {
    if (!selectedChannelId) {
      toast.error("Please select a target channel.");
      return;
    }
    setIsScanningChannel(true);
    setScrapedItems([]);
    setSelectedMsgMap({});
    setPasswordOverrideMap({});
    const res = await browserScrapeChannel({
      channelId: selectedChannelId,
      limit: scrapeLimit,
    });
    setIsScanningChannel(false);
    if (res.ok && res.data.status === "ok") {
      const items = res.data.items || [];
      setScrapedItems(items);
      const selMap: Record<number, boolean> = {};
      const pwMap: Record<number, string> = {};
      for (const it of items) {
        selMap[it.messageId] = !it.alreadyArchived && !it.blacklisted;
        pwMap[it.messageId] = it.resolvedPassword;
      }
      setSelectedMsgMap(selMap);
      setPasswordOverrideMap(pwMap);
      const newCount = items.filter((it) => !it.alreadyArchived && !it.blacklisted).length;
      const blCount = items.filter((it) => it.blacklisted).length;
      toast.success(
        `Found ${items.length} archives (${newCount} new, ${blCount} bad password, ${items.length - newCount - blCount} in vault).`,
      );
    } else {
      toast.error(
        !res.ok
          ? (res.error?.message ?? "Scraping failed.")
          : (res.data?.message ?? "Scraping failed."),
      );
    }
  }, [setPasswordOverrideMap, scrapeLimit, selectedChannelId, setSelectedMsgMap]);

  const selectOnlyNew = useCallback(() => {
    const next: Record<number, boolean> = {};
    for (const it of scrapedItems) {
      next[it.messageId] = !it.alreadyArchived && !it.blacklisted;
    }
    setSelectedMsgMap(next);
  }, [scrapedItems, setSelectedMsgMap]);

  const handleClearBlacklist = useCallback(async () => {
    if (!selectedChannelId) return;
    const res = await browserClearChannelBlacklist(selectedChannelId);
    if (res.ok) {
      toast.success("Blacklist cleared for this channel. Re-scanning...");
      void handleScanChannel();
    } else {
      toast.error("Failed to clear blacklist.");
    }
  }, [handleScanChannel, selectedChannelId]);

  const selectAll = useCallback(() => {
    const next: Record<number, boolean> = {};
    for (const it of scrapedItems) next[it.messageId] = true;
    setSelectedMsgMap(next);
  }, [scrapedItems, setSelectedMsgMap]);

  const handleImportScrapedBatch = useCallback(async () => {
    const selectedItems = scrapedItems.filter((it) => selectedMsgMap[it.messageId]);
    if (selectedItems.length === 0) {
      toast.error("Please select at least one archive to import.");
      return;
    }

    const itemsPayload = selectedItems.map((it) => ({
      messageId: it.messageId,
      filename: it.filename,
      sizeBytes: it.sizeBytes,
      password:
        passwordOverrideMap[it.messageId] !== undefined
          ? passwordOverrideMap[it.messageId]
          : it.resolvedPassword,
    }));

    setIsImportingScraped(true);
    const res = await browserEnqueueTelegramBatch({
      channelId: selectedChannelId,
      items: itemsPayload,
    });
    setIsImportingScraped(false);

    if (res.ok) {
      setIsAutoScrapeOpen(false);
      toast.success(
        `Added ${res.data.queuedCount} archives to server queue. You can close your browser anytime.`,
      );
      const q = await browserGetTelegramQueue();
      if (q.ok) setServerQueue(q.data);
    } else {
      toast.error(res.error?.message || "Failed to enqueue archives");
    }
  }, [passwordOverrideMap, scrapedItems, selectedChannelId, selectedMsgMap, setIsAutoScrapeOpen]);

  const seenCompletedRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    let cancelled = false;

    async function poll() {
      const res = await browserGetTelegramQueue();
      if (!cancelled && res.ok) {
        setServerQueue(res.data);
        const completedDoneIds = (res.data.completed ?? [])
          .filter((it) => it.stage === "done")
          .map((it) => it.id);
        if (seenCompletedRef.current === null) {
          seenCompletedRef.current = new Set(completedDoneIds);
        } else {
          let sawNewCompletion = false;
          for (const id of completedDoneIds) {
            if (!seenCompletedRef.current.has(id)) {
              seenCompletedRef.current.add(id);
              sawNewCompletion = true;
            }
          }
          if (
            sawNewCompletion ||
            (res.data.active && res.data.active.stage === "done")
          ) {
            router.refresh();
          }
        }
      }
      const hasActive =
        res.ok && (res.data.active !== null || res.data.pendingCount > 0);
      const nextDelay = hasActive ? 1000 : 5000;
      if (!cancelled) {
        timer = setTimeout(poll, nextDelay);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  const filteredArchives = archives.filter((a) => {
    if (formatFilter !== "all" && a.format.toLowerCase() !== formatFilter) {
      return false;
    }
    if (!archiveSearchQuery.trim()) return true;
    const q = archiveSearchQuery.trim().toLowerCase();
    return (
      a.filename.toLowerCase().includes(q) ||
      a.format.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-5">
      {/* Architectural Obsidian Telemetry Ribbon */}
      <section className="obsidian-panel grid grid-cols-2 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Vault Containers</span>
            <Archive className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {totalArchives.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">archives</span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Indexed Entries</span>
            <FileText className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {indexedFiles.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">
              files · {indexedDirs.toLocaleString()} dirs
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Uncompressed Data</span>
            <HardDrive className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {formatBytes(totalIndexedBytes)}
            </span>
            <span className="text-[11px] text-[#6b707b]">
              ({formatBytes(totalPackedBytes)} packed)
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Encrypted Sets</span>
            <Lock className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {encryptedVaults.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">
              password-protected
            </span>
          </div>
        </div>
      </section>

      {/* Unified Ingestion & Pipeline Bar */}
      <section className="obsidian-panel flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div
            role="button"
            tabIndex={0}
            aria-disabled={isUploading}
            onClick={() => {
              if (!isUploading) fileInputRef.current?.click();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (!isUploading) fileInputRef.current?.click();
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragActive(true);
            }}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragActive(false);
              if (!isUploading) void onPickFiles(event.dataTransfer.files);
            }}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-3 text-left transition-colors",
              isDragActive
                ? "border-white/30 bg-white/[0.04]"
                : "border-white/[0.09] bg-[#101216] hover:border-white/[0.18] hover:bg-[#13161b]",
              isUploading && "pointer-events-none opacity-60",
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-[#161920] text-[#c8ccd4]">
                <Upload className="size-3.5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-[#f3f4f6]">
                  Drop .zip, .7z, or multi-part .rar archives here, or click to browse
                </p>
                <p className="truncate text-[11px] text-[#6b707b]">
                  Supports multi-volume sets (.part01.rar, .part02.rar) · Automatic password dictionary probing
                </p>
              </div>
            </div>
            <span className="obsidian-pill shrink-0 font-mono text-[10px]">
              Max 100 GB
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.7z,.rar"
              multiple
              className="hidden"
              onChange={(event) => {
                void onPickFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openAutoScrapeDialog()}
              className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              <Radio className="size-3.5 text-[#10b981]" />
              Telegram Scraper
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleReindexAll()}
              disabled={isReindexingAll || isUploading}
              className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              <RefreshCw
                className={cn("size-3.5", isReindexingAll && "animate-spin")}
              />
              {isReindexingAll ? "Reindexing…" : "Reindex All"}
            </Button>
          </div>
        </div>

        {generalError !== null ? (
          <Alert variant="destructive" className="rounded-lg py-2.5 text-xs">
            <AlertDescription>{generalError}</AlertDescription>
          </Alert>
        ) : null}

        {/* Active Client Upload Queue */}
        {uploadQueue.length > 0 ? (
          <div className="obsidian-subpanel flex flex-col gap-2.5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-[#f3f4f6]">
                Upload Queue ({finishedCount}/{uploadQueue.length} completed)
              </span>
              <div className="flex items-center gap-3">
                {failedCount > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setUploadQueue((prev) =>
                        prev.filter((it) => it.stage !== "error"),
                      )
                    }
                    className="text-[11px] text-[#f43f5e] hover:underline cursor-pointer"
                  >
                    Clear failed ({failedCount})
                  </button>
                ) : null}
                {finishedCount > 0 && !isUploading ? (
                  <button
                    type="button"
                    onClick={() =>
                      setUploadQueue((prev) =>
                        prev.filter((it) => it.stage !== "done"),
                      )
                    }
                    className="text-[11px] text-[#10b981] hover:underline cursor-pointer"
                  >
                    Clear finished ({finishedCount})
                  </button>
                ) : null}
                {!isUploading ? (
                  <button
                    type="button"
                    onClick={() => setUploadQueue([])}
                    className="text-[11px] text-[#6b707b] hover:text-[#f3f4f6] cursor-pointer"
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {uploadQueue.map((item) => (
                <div
                  key={item.id}
                  className="rounded-md border border-white/[0.05] bg-[#0b0c0e] p-2.5"
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className="min-w-0 max-w-full truncate font-mono font-medium text-[#f3f4f6]"
                      title={item.filename}
                    >
                      {item.filename}
                    </span>
                    {item.format !== null ? (
                      <span className="obsidian-pill font-mono text-[10px] uppercase">
                        {item.format}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-2 font-mono text-[11px] tabular-nums text-[#8b909a]">
                      {item.stage === "uploading" &&
                      item.mbps !== undefined &&
                      item.mbps > 0 ? (
                        <span className="text-[#e5e7eb]">
                          {item.mbps.toFixed(1)} Mbps
                        </span>
                      ) : null}
                      {item.stage === "uploading" &&
                      item.etaSeconds !== undefined &&
                      item.etaSeconds > 0 ? (
                        <span className="text-[#6b707b]">
                          · {formatEta(item.etaSeconds)}
                        </span>
                      ) : null}
                      <span>
                        {formatBytes(item.loaded)} / {formatBytes(item.total)}
                      </span>
                      <span className="font-semibold text-[#f3f4f6]">
                        {item.percent}%
                      </span>
                    </span>
                  </div>
                  <div className="relative h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-200",
                        item.stage === "error"
                          ? "bg-[#f43f5e]"
                          : item.stage === "done"
                            ? "bg-[#10b981]"
                            : "bg-[#f3f4f6]",
                      )}
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px]">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        item.stage === "error"
                          ? "text-[#f43f5e]"
                          : item.stage === "done"
                            ? "text-[#10b981]"
                            : "text-[#8b909a]",
                      )}
                    >
                      {item.stage === "uploading" || item.stage === "indexing" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : null}
                      {item.error ? item.error : STAGE_LABELS[item.stage]}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Active Server MTProto Download Streams */}
      {serverQueue !== null &&
      (serverQueue.active !== null ||
        (serverQueue.activeList && serverQueue.activeList.length > 0) ||
        serverQueue.pendingCount > 0) ? (
        <section className="obsidian-panel flex flex-col gap-2.5 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="size-2 rounded-full bg-[#10b981]" />
              <span className="font-medium text-[#f3f4f6]">
                MTProto Ingestion Queue
              </span>
              {serverQueue.activeList && serverQueue.activeList.length > 0 ? (
                <span className="obsidian-pill font-mono text-[10px] text-[#10b981]">
                  {serverQueue.activeList.length} active
                </span>
              ) : null}
              {serverQueue.pendingCount > 0 ? (
                <span className="obsidian-pill font-mono text-[10px]">
                  +{serverQueue.pendingCount} pending
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px]">
              {serverQueue.totalSpeedMbps && serverQueue.totalSpeedMbps > 0 ? (
                <span className="text-[#10b981]">
                  {serverQueue.totalSpeedMbps.toFixed(1)} Mbps
                </span>
              ) : null}
              <button
                type="button"
                onClick={async () => {
                  await browserClearTelegramQueue();
                  const q = await browserGetTelegramQueue();
                  if (q.ok) setServerQueue(q.data);
                  toast.info("Cleared background download queue.");
                }}
                className="text-[11px] text-[#8b909a] hover:text-[#f43f5e] cursor-pointer"
              >
                Cancel Queue
              </button>
            </div>
          </div>

          {(serverQueue.activeList && serverQueue.activeList.length > 0
            ? serverQueue.activeList
            : serverQueue.active
              ? [serverQueue.active]
              : []
          ).map((stream, idx) => (
            <div
              key={stream.id}
              className="obsidian-subpanel flex flex-col gap-1.5 p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="obsidian-pill font-mono text-[10px]">
                    #{idx + 1}
                  </span>
                  <span
                    className="truncate font-mono text-xs font-medium text-[#f3f4f6]"
                    title={stream.filename}
                  >
                    {stream.filename}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] text-[#8b909a]">
                  {stream.speedMbps > 0 ? (
                    <span className="text-[#10b981]">
                      {stream.speedMbps.toFixed(1)} Mbps
                    </span>
                  ) : null}
                  {stream.etaSeconds > 0 ? (
                    <span className="text-[#6b707b]">
                      · {formatEta(stream.etaSeconds)}
                    </span>
                  ) : null}
                  {stream.totalBytes > 0 ? (
                    <span>
                      {formatBytes(stream.loadedBytes)} /{" "}
                      {formatBytes(stream.totalBytes)} (
                      {stream.percent.toFixed(0)}%)
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={cn(
                    "h-full rounded-full bg-[#10b981] transition-all duration-300",
                    stream.stage === "indexing" && "w-full animate-pulse",
                  )}
                  style={
                    stream.stage === "downloading"
                      ? { width: `${Math.min(100, Math.max(2, stream.percent))}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {/* Vault Container Ledger */}
      <section className="spinup-card obsidian-panel min-w-0 w-full overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-white/[0.06] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-[#f3f4f6]">
              Indexed Containers
            </h2>
            <span className="obsidian-pill font-mono text-[11px]">
              {filteredArchives.length}
            </span>

            <div className="ml-1 flex items-center gap-1 rounded-md border border-white/[0.06] bg-[#101216] p-0.5">
              {(["all", "zip", "rar", "7z"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setFormatFilter(fmt)}
                  className={cn(
                    "rounded px-2 py-0.5 font-mono text-[10px] uppercase transition-colors cursor-pointer",
                    formatFilter === fmt
                      ? "bg-white/[0.08] text-[#f3f4f6] font-medium"
                      : "text-[#6b707b] hover:text-[#c8ccd4]",
                  )}
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>

          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-[#6b707b]" />
            <input
              type="text"
              value={archiveSearchQuery}
              onChange={(e) => setArchiveSearchQuery(e.target.value)}
              placeholder="Filter containers..."
              aria-label="Search archives"
              className="obsidian-input h-8 w-full pl-8 pr-3 text-xs sm:w-64"
            />
          </div>
        </div>

        {filteredArchives.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-sm font-medium text-[#f3f4f6]">
              {archives.length === 0
                ? "No archives indexed yet"
                : "No matching containers"}
            </p>
            <p className="mt-1 text-xs text-[#6b707b]">
              {archives.length === 0
                ? "Drop a .zip, .7z, or .rar archive above to index its directory structure and credentials."
                : "Adjust your search filter or format selection."}
            </p>
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-white/[0.06] bg-[#101216]/70 text-[11px] font-medium text-[#8b909a]">
                  <th className="w-full max-w-0 min-w-[260px] py-2.5 pl-4 pr-3 font-medium">
                    Container
                  </th>
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">
                    Volume Size
                  </th>
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">
                    Structure
                  </th>
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">
                    Indexed At
                  </th>
                  <th className="py-2.5 px-3 font-medium whitespace-nowrap">
                    Status
                  </th>
                  <th className="py-2.5 pl-3 pr-5 text-right font-medium whitespace-nowrap">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {filteredArchives.map((archive) => (
                  <tr
                    key={archive.id}
                    className="group transition-colors hover:bg-white/[0.02]"
                  >
                    <td className="w-full max-w-0 min-w-[260px] py-3 pl-4 pr-3">
                      <Link
                        href={`/archives/${archive.id}`}
                        className="flex min-w-0 items-center gap-3"
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-white/[0.07] bg-[#101216] text-[#8b909a] group-hover:border-white/[0.15] group-hover:text-[#f3f4f6]">
                          <FileArchive className="size-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className="truncate text-xs font-medium text-[#f3f4f6] group-hover:underline"
                              title={archive.filename}
                            >
                              {archive.filename}
                            </span>
                            <span className="obsidian-pill shrink-0 font-mono text-[10px] uppercase">
                              {archive.format}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-[#6b707b]">
                            {formatBytes(archive.sizeBytes)} packed · sha256:
                            {archive.sha256.slice(0, 8)}
                          </p>
                        </div>
                      </Link>
                    </td>
                    <td className="py-3 px-3 font-mono text-xs tabular-nums text-[#e5e7eb] whitespace-nowrap">
                      {formatBytes(archive.uncompressedBytes)}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs tabular-nums text-[#c8ccd4] whitespace-nowrap">
                      {archive.fileCount.toLocaleString()} files{" "}
                      <span className="text-[#6b707b]">
                        · {archive.dirCount.toLocaleString()} dirs
                      </span>
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] tabular-nums text-[#8b909a] whitespace-nowrap">
                      {new Date(archive.createdAt)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " ")}{" "}
                      UTC
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {archive.status === "password_required" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setUnlockArchive(archive);
                              setUnlockPassword("");
                              setUnlockError(null);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                          >
                            <Lock className="size-3" />
                            Password Required
                          </button>
                        ) : (
                          <>
                            <span className="obsidian-badge-active inline-flex items-center gap-1.5">
                              <span className="size-1.5 rounded-full bg-[#10b981]" />
                              Indexed
                            </span>
                            {archive.isEncrypted ? (
                              <span
                                title="Password Stored"
                                className="obsidian-pill inline-flex items-center gap-1 text-[#c8ccd4]"
                              >
                                <Lock className="size-2.5 text-[#8b909a]" />
                                <span className="hidden xl:inline">Unlocked</span>
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1">
                        {archive.status === "password_required" ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              setUnlockArchive(archive);
                              setUnlockPassword("");
                              setUnlockError(null);
                            }}
                            className="h-7 gap-1 rounded-md border-amber-500/30 bg-amber-500/10 px-2.5 text-xs text-amber-300 hover:bg-amber-500/20"
                          >
                            <Lock className="size-3" />
                            Unlock
                          </Button>
                        ) : (
                          <Button
                            asChild
                            size="xs"
                            variant="outline"
                            className="h-7 gap-1 rounded-md border-white/[0.08] bg-[#101216] px-2.5 text-xs text-[#f3f4f6] hover:bg-white/[0.06]"
                          >
                            <Link href={`/archives/${archive.id}`}>
                              Inspect
                              <ArrowUpRight className="size-3" />
                            </Link>
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={reindexingId === archive.id || isReindexingAll}
                          onClick={() => void handleReindexOne(archive.id)}
                          title="Re-run indexer on this archive"
                          className="h-7 w-7 p-0 text-[#8b909a] hover:text-[#f3f4f6]"
                        >
                          <RotateCcw
                            className={cn(
                              "size-3.5",
                              reindexingId === archive.id && "animate-spin",
                            )}
                          />
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-label={`Delete ${archive.filename}`}
                          title={`Delete ${archive.filename}`}
                          className="h-7 w-7 p-0 text-[#8b909a] hover:text-[#f43f5e]"
                          onClick={async () => {
                            const targetId = archive.id;
                            const targetName = archive.filename;
                            setArchives((prev) =>
                              prev.filter((a) => a.id !== targetId),
                            );
                            toast.success(
                              `Deleted "${targetName}". Cleaning up in background...`,
                            );

                            const result = await browserDeleteArchive(targetId);
                            if (!result.ok) {
                              toast.error(
                                result.error?.message ??
                                  "Delete failed. Restoring list...",
                              );
                              router.refresh();
                            }
                          }}
                        >
                          {isDeletingId === archive.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Password Unlock Modal */}
      <Dialog
        open={unlockArchive !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isUnlocking && unlockArchive !== null) {
            const pendingId = unlockArchive.id;
            setUnlockArchive(null);
            setUnlockError(null);
            setArchives((prev) => prev.filter((a) => a.id !== pendingId));
            void browserDeleteArchive(pendingId);
          }
        }}
      >
        <DialogContent className="rounded-xl border border-white/[0.08] bg-[#0b0c0e] text-[#f3f4f6] sm:max-w-md">
          {unlockArchive !== null ? (
            <div className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Lock className="size-4 text-amber-400" />
                  Encrypted Archive Detected
                </DialogTitle>
                <DialogDescription className="text-xs text-[#8b909a]">
                  Enter the archive password once to index its contents and store
                  it for zero-extraction browsing.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-[#101216] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-[#f3f4f6]">
                  {unlockArchive.filename}
                </span>
                <span className="obsidian-pill font-mono text-[10px] uppercase">
                  {unlockArchive.format}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="unlock-password" className="text-xs text-[#c8ccd4]">
                  Archive password
                </Label>
                <div className="relative">
                  <Input
                    id="unlock-password"
                    type={showUnlockPassword ? "text" : "password"}
                    value={unlockPassword}
                    onChange={(event) => setUnlockPassword(event.target.value)}
                    disabled={isUnlocking}
                    autoFocus
                    className="obsidian-input h-9 pr-9 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowUnlockPassword((v) => !v)}
                    aria-label={
                      showUnlockPassword ? "Hide password" : "Show password"
                    }
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8b909a] hover:text-[#f3f4f6]"
                  >
                    {showUnlockPassword ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </button>
                </div>
                {unlockError !== null ? (
                  <Alert variant="destructive" className="py-2 text-xs">
                    <AlertDescription>{unlockError}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
              <Button
                className="h-9 w-full rounded-lg bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
                disabled={isUnlocking || unlockPassword.length === 0}
                onClick={() => void handleUnlock()}
              >
                {isUnlocking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Lock className="size-3.5" />
                )}
                Unlock &amp; Index Archive
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Telegram Auto-Scrape Modal */}
      <Dialog open={isAutoScrapeOpen} onOpenChange={setIsAutoScrapeOpen}>
        <DialogContent className="flex max-h-[85vh] w-[92vw] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0b0c0e] p-6 text-[#f3f4f6] sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b border-white/[0.06] pb-3">
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-[#f3f4f6]">
              <Radio className="size-4 text-[#10b981]" />
              Telegram Channel Auto-Scrape Importer
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8b909a]">
              Scan recent channel messages for archives, resolve passwords, and enqueue parallel MTProto downloads.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2 sm:overflow-hidden">
            {scrapeChannels.length === 0 ? (
              <div className="obsidian-subpanel flex flex-1 flex-col items-center justify-center p-8 text-center">
                <Radio className="mb-2 size-6 text-[#5c606a]" />
                <p className="text-xs font-medium text-[#e5e7eb]">
                  No channels configured
                </p>
                <p className="mt-1 max-w-sm text-xs text-[#6b707b]">
                  Configure your Telegram channels and password extraction scripts in the Channels workspace first.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-4 h-8 text-xs">
                  <Link href="/channels">Configure Channels</Link>
                </Button>
              </div>
            ) : (
              <>
                <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1 sm:col-span-2">
                    <label className="text-[11px] font-medium text-[#8b909a]">
                      Channel
                    </label>
                    <select
                      value={selectedChannelId}
                      onChange={(e) => setSelectedChannelId(e.target.value)}
                      className="obsidian-input h-8.5 w-full px-2.5 text-xs"
                    >
                      {scrapeChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.channelId})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-[#8b909a]">
                      Messages to scan
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={10}
                        max={500}
                        value={scrapeLimit}
                        onChange={(e) =>
                          setScrapeLimit(parseInt(e.target.value, 10) || 50)
                        }
                        className="obsidian-input h-8.5 font-mono text-xs"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleScanChannel()}
                        disabled={isScanningChannel}
                        className="h-8.5 shrink-0 bg-[#f3f4f6] px-3.5 text-xs font-medium text-[#050506] hover:bg-white"
                      >
                        {isScanningChannel ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        {isScanningChannel ? "Scanning…" : "Scan"}
                      </Button>
                    </div>
                  </div>
                </div>

                {scrapedItems.length > 0 ? (
                  <div className="flex min-h-0 shrink-0 flex-col gap-2 sm:flex-1">
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-[#8b909a]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-[#e5e7eb]">
                          Found {scrapedItems.length} archives
                        </span>
                        <span>·</span>
                        <span className="font-medium text-[#10b981]">
                          {
                            scrapedItems.filter(
                              (it) => !it.alreadyArchived && !it.blacklisted,
                            ).length
                          }{" "}
                          new
                        </span>
                        {scrapedItems.some((it) => it.blacklisted) ? (
                          <div className="flex items-center gap-1">
                            <span>·</span>
                            <span className="font-medium text-[#f43f5e]">
                              {scrapedItems.filter((it) => it.blacklisted).length}{" "}
                              bad password
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleClearBlacklist()}
                              className="text-[10px] text-[#8b909a] hover:text-[#f43f5e] hover:underline cursor-pointer"
                            >
                              (Reset)
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          onClick={selectOnlyNew}
                          className="text-[#10b981] hover:underline cursor-pointer"
                        >
                          Select new
                        </button>
                        <span className="text-[#3a3d45]">|</span>
                        <button
                          type="button"
                          onClick={selectAll}
                          className="text-[#8b909a] hover:text-[#f3f4f6] cursor-pointer"
                        >
                          Select all
                        </button>
                        <span className="text-[#3a3d45]">|</span>
                        <button
                          type="button"
                          onClick={() => setSelectedMsgMap({})}
                          className="text-[#8b909a] hover:text-[#f3f4f6] cursor-pointer"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 divide-y divide-white/[0.04] overflow-y-auto rounded-lg border border-white/[0.06] bg-[#101216]">
                      {scrapedItems.map((it) => {
                        const isChecked = Boolean(selectedMsgMap[it.messageId]);
                        return (
                          <div
                            key={it.messageId}
                            className={cn(
                              "flex flex-wrap items-center gap-2.5 p-2.5 text-xs hover:bg-white/[0.02]",
                              isChecked && "bg-white/[0.015]",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedMsgMap((prev) => ({
                                  ...prev,
                                  [it.messageId]: !isChecked,
                                }))
                              }
                              className="shrink-0 text-[#8b909a] hover:text-white cursor-pointer"
                            >
                              {isChecked ? (
                                <CheckSquare className="size-4 text-[#10b981]" />
                              ) : (
                                <Square className="size-4" />
                              )}
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <p
                                  className="truncate font-mono font-medium text-[#f3f4f6]"
                                  title={it.filename}
                                >
                                  {it.filename}
                                </p>
                                {it.alreadyArchived ? (
                                  <span className="obsidian-pill text-[10px]">
                                    In Vault
                                  </span>
                                ) : it.blacklisted ? (
                                  <Badge
                                    variant="destructive"
                                    className="text-[10px] font-normal"
                                  >
                                    Bad Password
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="font-mono text-[11px] text-[#6b707b]">
                                {formatBytes(it.sizeBytes)} · {it.date.slice(0, 10)}
                              </p>
                            </div>

                            <div className="flex min-w-0 basis-full items-center gap-1.5 sm:w-44 sm:shrink-0 sm:basis-auto">
                              <span className="shrink-0 font-mono text-[10px] text-[#6b707b]">
                                PW:
                              </span>
                              <Input
                                type="text"
                                value={
                                  passwordOverrideMap[it.messageId] !== undefined
                                    ? passwordOverrideMap[it.messageId]
                                    : it.resolvedPassword
                                }
                                onChange={(e) =>
                                  setPasswordOverrideMap((prev) => ({
                                    ...prev,
                                    [it.messageId]: e.target.value,
                                  }))
                                }
                                placeholder="(none)"
                                className="obsidian-input h-7 px-2 font-mono text-[11px]"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="obsidian-subpanel flex flex-1 flex-col items-center justify-center p-8 text-center text-xs text-[#6b707b]">
                    Select a channel and click &ldquo;Scan&rdquo; to discover archives.
                  </div>
                )}

                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                  <div className="text-xs text-[#8b909a]">
                    {scrapedItems.length > 0 ? (
                      <span>
                        Selected:{" "}
                        <strong className="text-[#f3f4f6]">
                          {
                            scrapedItems.filter(
                              (it) => selectedMsgMap[it.messageId],
                            ).length
                          }
                        </strong>{" "}
                        archives (
                        {formatBytes(
                          scrapedItems
                            .filter((it) => selectedMsgMap[it.messageId])
                            .reduce((acc, it) => acc + it.sizeBytes, 0),
                        )}
                        )
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsAutoScrapeOpen(false)}
                      className="h-8 text-xs text-[#8b909a]"
                    >
                      Close
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleImportScrapedBatch()}
                      disabled={
                        isImportingScraped ||
                        scrapedItems.length === 0 ||
                        scrapedItems.filter((it) => selectedMsgMap[it.messageId])
                          .length === 0
                      }
                      className="h-8 gap-1.5 bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
                    >
                      {isImportingScraped ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                      {isImportingScraped
                        ? "Queueing…"
                        : `Queue Downloads (${scrapedItems.filter((it) => selectedMsgMap[it.messageId]).length})`}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
