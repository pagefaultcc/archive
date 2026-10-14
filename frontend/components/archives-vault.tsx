"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Check,
  CheckSquare,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  Loader2,
  Lock,
  Radio,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { Icon3D, Magnetic, SpringCounter } from "@/components/kinetics-ui";
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
  browserImportScrapedFiles,
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

// UPLOAD_CONCURRENCY is the maximum number of simultaneous upload streams.
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
    return `${s} second${s === 1 ? "" : "s"} left`;
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
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const isUploading = uploadQueue.some(
    (item) => item.stage === "uploading" || item.stage === "indexing" || item.stage === "queued",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [unlockArchive, setUnlockArchive] = useState<ArchiveItem | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [showUnlockPassword, setShowUnlockPassword] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);
  const [isReindexingAll, setIsReindexingAll] = useState(false);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
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
  const [importProgressText, setImportProgressText] = useState("");
  const [serverQueue, setServerQueue] = useState<TelegramQueueStatus | null>(null);

  const totalArchives = archives.length;
  const indexedFiles = archives.reduce(
    (sum, archive) => sum + archive.fileCount,
    0,
  );
  const encryptedVaults = archives.filter((a) => a.isEncrypted).length;
  const totalIndexedBytes = archives.reduce(
    (sum, archive) => sum + archive.uncompressedBytes,
    0,
  );

  const uploadSingle = useCallback(
    async (file: File, itemId: string): Promise<ArchiveItem | null> => {
      const format = formatOf(file.name);
      if (format === null) {
        setUploadQueue((prev) =>
          prev.map((it) =>
            it.id === itemId
              ? { ...it, stage: "error", error: "Unsupported format. Use .zip, .7z, or .rar." }
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
            ? { ...it, stage: "uploading", percent: 0, startedAt: startTime, mbps: 0, etaSeconds: undefined }
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
    [],
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

      // Upload with controlled parallelism: at most UPLOAD_CONCURRENCY
      // streams in flight, each updating its own progress bar live.
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
      if (files.length === 1 && lastUploadedArchive) {
        router.push(`/archives/${lastUploadedArchive.id}`);
      }
    },
    [router, uploadSingle],
  );

  const clearFailed = useCallback(() => {
    setUploadQueue((prev) => prev.filter((it) => it.stage !== "error"));
  }, []);
  const clearFinished = useCallback(() => {
    setUploadQueue((prev) => prev.filter((it) => it.stage !== "done"));
  }, []);
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
  }, [isUnlocking, router, unlockArchive, unlockPassword]);
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
  }, []);

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
      // Select ONLY new archives by default (skip already archived AND blacklisted bad passwords)
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
        `Found ${items.length} archives (${newCount} new, ${blCount} bad password, ${items.length - newCount - blCount} in vault).`
      );
    } else {
      toast.error(!res.ok ? (res.error?.message ?? "Scraping failed.") : (res.data?.message ?? "Scraping failed."));
    }
  }, [scrapeLimit, selectedChannelId]);

  const selectOnlyNew = useCallback(() => {
    const next: Record<number, boolean> = {};
    for (const it of scrapedItems) {
      next[it.messageId] = !it.alreadyArchived && !it.blacklisted;
    }
    setSelectedMsgMap(next);
  }, [scrapedItems]);

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
  }, [scrapedItems]);

  const deselectAll = useCallback(() => {
    setSelectedMsgMap({});
  }, []);

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
        `Added ${res.data.queuedCount} archives to server queue. You can close your browser anytime.`
      );
      const q = await browserGetTelegramQueue();
      if (q.ok) setServerQueue(q.data);
    } else {
      toast.error(res.error?.message || "Failed to enqueue archives");
    }
  }, [passwordOverrideMap, scrapedItems, selectedChannelId, selectedMsgMap]);

  // Periodic server queue monitor (runs even when modal is closed)
  useEffect(() => {
    let timer: NodeJS.Timeout;
    let cancelled = false;

    async function poll() {
      const res = await browserGetTelegramQueue();
      if (!cancelled && res.ok) {
        setServerQueue(res.data);
        if (res.data.active && res.data.active.stage === "done") {
          router.refresh();
        }
      }
      const hasActive = res.ok && (res.data.active !== null || res.data.pendingCount > 0);
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

  return (
    <div className="flex flex-1 flex-col gap-5 spring-enter">
      {/* Top modular summary strip */}
      <section className="kinetics-card w-full rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <Icon3D name="tools" size="md" />
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold tracking-tight text-[#f7f8f8]">
                Archive
              </h2>
              <span className="text-xs text-[#8a8f98]">
                Supports .zip, .7z, and .rar up to 10 GB
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Total archives", value: totalArchives, accent: "border-sky-500/20 bg-sky-500/[0.02]" },
              { label: "Indexed files", value: indexedFiles, accent: "border-emerald-500/20 bg-emerald-500/[0.02]" },
              { label: "Encrypted vaults", value: encryptedVaults, accent: "border-amber-500/20 bg-amber-500/[0.02]" },
              {
                label: "Total indexed size",
                value: null,
                text: formatBytes(totalIndexedBytes),
                accent: "border-violet-500/20 bg-violet-500/[0.02]",
              },
            ].map((metric) => (
              <div
                key={metric.label}
                className={cn(
                  "flex flex-col gap-0.5 rounded-[8px] border px-3 py-2.5 transition-all duration-200 hover:border-opacity-40",
                  metric.accent
                )}
              >
                <span className="text-[11px] font-medium uppercase tracking-wide text-[#8a8f98]">
                  {metric.label}
                </span>
                <span className="text-lg font-semibold tabular-nums tracking-tight text-[#f7f8f8]">
                  {metric.text ?? <SpringCounter value={metric.value ?? 0} />}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Upload panel */}
      <section className="kinetics-card w-full rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold tracking-tight text-[#f7f8f8]">
              Upload archive
            </h3>
            <Badge variant="secondary" className="rounded-[9999px]">
              Up to 100 GB
            </Badge>
          </div>
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
              if (!isUploading) onPickFiles(event.dataTransfer.files);
            }}
            className={
              "flex cursor-pointer flex-col items-center gap-2 rounded-[8px] border border-dashed px-6 py-8 text-center transition-colors duration-200 " +
              (isDragActive
                ? "border-[rgba(255,255,255,0.28)] bg-[rgba(255,255,255,0.05)]"
                : "border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.015)] hover:border-[rgba(255,255,255,0.22)] hover:bg-[rgba(255,255,255,0.03)]") +
              (isUploading ? " pointer-events-none opacity-60" : "")
            }
          >
            <Upload className="size-5 text-[#8a8f98]" />
            <p className="text-sm font-medium text-[#f7f8f8]">
              Drag &amp; drop .zip, .7z, or multiple .rar archive parts here, or click to
              browse
            </p>
            <p className="text-xs text-[#62666d]">
              Supports multi-file selection (.part1.rar, .part2.rar, etc.) · Password-protected archives detected automatically
            </p>
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

          {generalError !== null ? (
            <Alert variant="destructive" className="rounded-[8px]">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          ) : null}

          {/* Multi-archive upload queue cards */}
          {uploadQueue.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-[8px] border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)] p-3.5">
              <div className="flex items-center justify-between text-xs text-[#8a8f98]">
                <span className="font-medium text-[#f7f8f8]">
                  Upload Queue ({uploadQueue.filter((it) => it.stage === "done").length}/{uploadQueue.length} completed)
                </span>
                <div className="flex items-center gap-3">
                  {failedCount > 0 ? (
                    <button
                      type="button"
                      onClick={clearFailed}
                      className="text-[11px] text-[#f91880] hover:opacity-80"
                    >
                      Clear failed ({failedCount})
                    </button>
                  ) : null}
                  {finishedCount > 0 && !isUploading ? (
                    <button
                      type="button"
                      onClick={clearFinished}
                      className="text-[11px] text-[#00ba7c] hover:opacity-80"
                    >
                      Clear finished ({finishedCount})
                    </button>
                  ) : null}
                  {!isUploading ? (
                    <button
                      type="button"
                      onClick={() => setUploadQueue([])}
                      className="text-[11px] text-[#62666d] hover:text-[#f7f8f8]"
                    >
                      Clear all
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col gap-2.5">
                {uploadQueue.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-[6px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.015)] p-2.5"
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-xs font-medium text-[#f7f8f8]">
                        {item.filename}
                      </span>
                      {item.format !== null ? (
                        <Badge variant="outline" className="font-mono text-[10px] uppercase">
                          {item.format}
                        </Badge>
                      ) : null}
                      <span className="ml-auto flex items-center gap-2 font-mono text-[11px] tabular-nums text-[#8a8f98]">
                        {item.stage === "uploading" && item.mbps !== undefined && item.mbps > 0 ? (
                          <span className="text-[#d0d6e0]">
                            {item.mbps.toFixed(1)} Mbps
                          </span>
                        ) : null}
                        {item.stage === "uploading" && item.etaSeconds !== undefined && item.etaSeconds > 0 ? (
                          <span className="text-[#62666d]">
                            · {formatEta(item.etaSeconds)}
                          </span>
                        ) : null}
                        <span>
                          {formatBytes(item.loaded)} / {formatBytes(item.total)}
                        </span>
                      </span>
                      <span className="font-mono text-[11px] font-semibold tabular-nums text-[#f7f8f8]">
                        {item.percent}%
                      </span>
                    </div>
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]">
                      <div
                        className={cn(
                          "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out",
                          item.stage === "error"
                            ? "bg-[#f91880]"
                            : item.stage === "done"
                              ? "bg-[#00ba7c]"
                              : "kinetics-progress-fill",
                        )}
                        style={{ width: `${item.percent}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px]">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-medium",
                          item.stage === "error"
                            ? "text-[#f91880]"
                            : item.stage === "done"
                              ? "text-[#00ba7c]"
                              : "text-[#8a8f98]",
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

        </div>
      </section>

      {/* Background Server Download Indicator */}
      {serverQueue !== null && (serverQueue.active !== null || (serverQueue.activeList && serverQueue.activeList.length > 0) || serverQueue.pendingCount > 0) ? (
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-[rgba(0,186,124,0.3)] bg-[rgba(0,186,124,0.02)] p-3.5 text-xs shadow-[0_0_20px_rgba(0,186,124,0.03)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.06)] pb-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00ba7c] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00ba7c]" />
              </span>
              <span className="font-mono font-medium text-[#f7f8f8]">
                Parallel Downloader
              </span>
              {(serverQueue.activeList && serverQueue.activeList.length > 0) ? (
                <Badge variant="outline" className="text-[10px] text-[#00ba7c] border-[#00ba7c]/30 bg-[#00ba7c]/10 shrink-0 font-medium px-2 py-0.5">
                  {serverQueue.activeList.length} stream{serverQueue.activeList.length > 1 ? "s" : ""} downloading in parallel
                </Badge>
              ) : null}
              {serverQueue.pendingCount > 0 ? (
                <Badge variant="outline" className="text-[10px] text-[#8a8f98] shrink-0 font-normal">
                  +{serverQueue.pendingCount} queued
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px] text-[#8a8f98] shrink-0">
              {serverQueue.totalSpeedMbps && serverQueue.totalSpeedMbps > 0 ? (
                <span className="font-semibold text-[#00ba7c] bg-[#00ba7c]/15 px-2 py-0.5 rounded text-[11px] border border-[#00ba7c]/20">
                  {serverQueue.totalSpeedMbps.toFixed(1)} Mbps total
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
                className="ml-2 text-[10px] text-[#8a8f98] hover:text-red-400 cursor-pointer transition-colors"
                title="Cancel pending background downloads"
              >
                (Clear Queue)
              </button>
            </div>
          </div>

          {/* Active Parallel Stream Cards */}
          {(serverQueue.activeList && serverQueue.activeList.length > 0
            ? serverQueue.activeList
            : serverQueue.active
            ? [serverQueue.active]
            : []
          ).map((stream, idx) => (
            <div key={stream.id} className="flex flex-col gap-1.5 rounded-[6px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.015)] p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-semibold">
                    Stream #{idx + 1}
                  </span>
                  <span className="font-mono font-medium text-[#d0d6e0] truncate text-[11px]">
                    {stream.filename}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px] text-[#8a8f98]">
                  {stream.speedMbps > 0 ? (
                    <span className="text-[#00ba7c] font-medium">{stream.speedMbps.toFixed(1)} Mbps</span>
                  ) : null}
                  {stream.etaSeconds > 0 ? (
                    <span className="text-[#62666d]">· {formatEta(stream.etaSeconds)}</span>
                  ) : null}
                  {stream.totalBytes > 0 ? (
                    <span>
                      {formatBytes(stream.loadedBytes)} / {formatBytes(stream.totalBytes)} ({stream.percent.toFixed(0)}%)
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    stream.stage === "indexing"
                      ? "bg-amber-500 w-full animate-pulse"
                      : "bg-gradient-to-r from-[#00ba7c] to-[#00d8a5]"
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
        </div>
      ) : null}

      {/* Archive Vault List */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight text-[#f7f8f8]">
            Indexed Archives ({archives.length})
          </h3>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={openAutoScrapeDialog}
              className="gap-1.5"
            >
              <Radio className="size-3" />
              Auto-Scrape
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleReindexAll}
              disabled={isReindexingAll || isUploading}
              className="gap-1.5"
            >
              <RefreshCw
                className={isReindexingAll ? "size-3 animate-spin" : "size-3"}
              />
              {isReindexingAll ? "Reindexing Everything…" : "Reindex Everything"}
            </Button>
          </div>
        </div>
        {archives.length === 0 ? (
          <div className="kinetics-card rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] px-6 py-10 text-center">
            <p className="text-sm font-medium text-[#f7f8f8]">
              No archives indexed yet
            </p>
            <p className="mt-1 text-xs text-[#62666d]">
              Upload a .zip, .7z, or .rar file above to open it in the
              multi-pane File Explorer.
            </p>
          </div>
        ) : (
          archives.map((archive) => (
            <div
              key={archive.id}
              className="kinetics-card flex flex-col gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <Link
                href={`/archives/${archive.id}`}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <Icon3D
                  name={archive.isEncrypted ? "lock" : "tools"}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-[#f7f8f8] hover:underline">
                      {archive.filename}
                    </span>
                    <Badge variant="outline" className="uppercase font-mono">
                      {archive.format}
                    </Badge>
                    {archive.isEncrypted ? (
                      <Badge variant="secondary">
                        <Lock className="size-3" />
                        Password Stored
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[#62666d]">
                    {formatBytes(archive.sizeBytes)} packed →{" "}
                    {formatBytes(archive.uncompressedBytes)} uncompressed ·{" "}
                    {archive.fileCount.toLocaleString()} files ·{" "}
                    {archive.dirCount.toLocaleString()} folders ·{" "}
                    {new Date(archive.createdAt)
                      .toISOString()
                      .slice(0, 19)
                      .replace("T", " ")}{" "}
                    UTC
                  </p>
                </div>
              </Link>

              <div className="flex shrink-0 items-center gap-2">
                <Magnetic strength={0.16}>
                  <Button asChild size="sm">
                    <Link href={`/archives/${archive.id}`}>
                      Open File Explorer
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  </Button>
                </Magnetic>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={reindexingId === archive.id || isReindexingAll}
                  onClick={() => void handleReindexOne(archive.id)}
                  title="Re-run indexer on this archive"
                  className="gap-1.5 text-[#8a8f98] hover:text-[#f7f8f8]"
                >
                  <RotateCcw
                    className={
                      reindexingId === archive.id
                        ? "size-3.5 animate-spin"
                        : "size-3.5"
                    }
                  />
                  Reindex
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${archive.filename}`}
                  className="rounded-[9999px] text-[#8a8f98] hover:text-[#f91880]"
                  onClick={async () => {
                    const targetId = archive.id;
                    const targetName = archive.filename;
                    // Instant optimistic removal from UI
                    setArchives((prev) => prev.filter((a) => a.id !== targetId));
                    toast.success(`Deleted "${targetName}". Cleaning up in background...`);

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
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          ))
        )}
      </section>

      {/* Automatic Upload-Time Password Prompt */}
      <Dialog
        open={unlockArchive !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isUnlocking && unlockArchive !== null) {
            const pendingId = unlockArchive.id;
            setUnlockArchive(null);
            setUnlockError(null);
            void browserDeleteArchive(pendingId);
          }
        }}
      >
        <DialogContent className="rounded-[8px] border-[rgba(255,255,255,0.07)] bg-[#0f1011] sm:max-w-md">
          {unlockArchive !== null ? (
            <div className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <Icon3D name="lock" size="md" />
                  Password-Protected Archive Detected
                </DialogTitle>
                <DialogDescription className="text-xs text-[#8a8f98]">
                  Enter the archive password once to index its contents and
                  store it — viewers in the File Explorer will never be asked
                  for a password.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-[#f7f8f8]">
                  {unlockArchive.filename}
                </span>
                <Badge variant="outline" className="uppercase font-mono">
                  {unlockArchive.format}
                </Badge>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="unlock-password">Archive password</Label>
                <div className="relative">
                  <Input
                    id="unlock-password"
                    type={showUnlockPassword ? "text" : "password"}
                    value={unlockPassword}
                    onChange={(event) => setUnlockPassword(event.target.value)}
                    disabled={isUnlocking}
                    autoFocus
                    className="h-10 rounded-[8px] border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] pr-10 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowUnlockPassword((v) => !v)}
                    aria-label={
                      showUnlockPassword ? "Hide password" : "Show password"
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[9999px] p-1.5 text-[#8a8f98] transition-colors hover:text-[#f7f8f8]"
                  >
                    {showUnlockPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                {unlockError !== null ? (
                  <Alert variant="destructive" className="rounded-[8px]">
                    <AlertDescription>{unlockError}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
              <Magnetic strength={0.18}>
                <Button
                  className="spring-interactive w-full rounded-[9999px]"
                  disabled={isUnlocking || unlockPassword.length === 0}
                  onClick={() => void handleUnlock()}
                >
                  {isUnlocking ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Lock className="mr-2 size-4" />
                  )}
                  Store password &amp; open File Explorer
                </Button>
              </Magnetic>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Auto-Scrape Telegram Dialog */}
      <Dialog open={isAutoScrapeOpen} onOpenChange={setIsAutoScrapeOpen}>
        <DialogContent className="border border-[rgba(255,255,255,0.1)] bg-[#0f1011] text-[#f7f8f8] sm:max-w-3xl w-[92vw] max-h-[85vh] flex flex-col p-6 overflow-hidden shadow-2xl">
          <DialogHeader className="shrink-0 pb-3 border-b border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2.5 text-base font-semibold text-[#ffffff]">
                <div className="flex size-7 items-center justify-center rounded-md bg-[rgba(255,255,255,0.05)] text-[#d0d6e0] border border-[rgba(255,255,255,0.08)]">
                  <Radio className="size-3.5 text-[#00ba7c]" />
                </div>
                Telegram Channel Auto-Scrape Importer
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-[#8a8f98]">
              Scrape recent channel messages for archives, auto-resolve passwords, and queue downloads on the server.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-1 flex-col gap-4 py-2 min-h-0 overflow-hidden">
            {scrapeChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center flex-1 rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.015)] p-8 text-center">
                <Radio className="size-8 text-[#62666d] mb-2" />
                <p className="text-sm font-medium text-[#d0d6e0]">No channels configured</p>
                <p className="mt-1 text-xs text-[#8a8f98] max-w-sm">
                  Configure your Telegram channels and custom password scripts under Moderation &gt; Channels first.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-4">
                  <Link href="/channels">Go to Channels</Link>
                </Button>
              </div>
            ) : (
              <>
                {/* Channel & Limit controls */}
                <div className="shrink-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2 flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-[#8a8f98]">
                      Select Channel
                    </label>
                    <select
                      value={selectedChannelId}
                      onChange={(e) => setSelectedChannelId(e.target.value)}
                      className="h-8.5 w-full rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[#08090a] px-2.5 text-xs text-[#d0d6e0] outline-none"
                    >
                      {scrapeChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.channelId})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-[#8a8f98]">
                      Messages to scan
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={10}
                        max={500}
                        value={scrapeLimit}
                        onChange={(e) => setScrapeLimit(parseInt(e.target.value, 10) || 50)}
                        className="h-8.5 font-mono text-xs bg-[#08090a]"
                      />
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={handleScanChannel}
                        disabled={isScanningChannel}
                        className="h-8.5 shrink-0 px-3.5"
                      >
                        {isScanningChannel ? (
                          <Loader2 className="size-3.5 animate-spin mr-1" />
                        ) : null}
                        {isScanningChannel ? "Scanning…" : "Scan"}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Scraped items selection list */}
                {scrapedItems.length > 0 ? (
                  <div className="flex flex-1 flex-col gap-2 min-h-0 overflow-hidden">
                    <div className="shrink-0 flex items-center justify-between text-xs text-[#8a8f98]">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-[#d0d6e0]">
                          Found {scrapedItems.length} archives
                        </span>
                        <span className="text-[#62666d]">·</span>
                        <span className="text-[#00ba7c] font-medium">
                          {scrapedItems.filter((it) => !it.alreadyArchived && !it.blacklisted).length} new
                        </span>
                        {scrapedItems.filter((it) => it.blacklisted).length > 0 ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[#62666d]">·</span>
                            <span className="text-red-400 font-medium">
                              {scrapedItems.filter((it) => it.blacklisted).length} bad password
                            </span>
                            <button
                              type="button"
                              onClick={handleClearBlacklist}
                              className="text-[10px] text-[#8a8f98] hover:text-red-400 hover:underline cursor-pointer"
                              title="Reset blacklist to allow re-trying"
                            >
                              (Reset)
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={selectOnlyNew}
                          className="text-[11px] text-[#00ba7c] hover:underline cursor-pointer"
                        >
                          Select new
                        </button>
                        <span className="text-[#62666d]">|</span>
                        <button
                          type="button"
                          onClick={selectAll}
                          className="text-[11px] text-[#8a8f98] hover:text-[#d0d6e0] cursor-pointer"
                        >
                          Select all
                        </button>
                        <span className="text-[#62666d]">|</span>
                        <button
                          type="button"
                          onClick={deselectAll}
                          className="text-[11px] text-[#8a8f98] hover:text-[#d0d6e0] cursor-pointer"
                        >
                          Deselect
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden divide-y divide-[rgba(255,255,255,0.03)] rounded-[6px] border border-[rgba(255,255,255,0.06)] bg-[#08090a]">
                      {scrapedItems.map((it) => {
                        const isChecked = Boolean(selectedMsgMap[it.messageId]);
                        return (
                          <div
                            key={it.messageId}
                            className={cn(
                              "flex items-center gap-2.5 p-2.5 text-xs hover:bg-[rgba(255,255,255,0.02)] transition-colors",
                              isChecked && "bg-[rgba(255,255,255,0.015)]"
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
                              className="cursor-pointer text-[#8a8f98] hover:text-[#ffffff] shrink-0"
                            >
                              {isChecked ? (
                                <CheckSquare className="size-4 text-[#00ba7c]" />
                              ) : (
                                <Square className="size-4" />
                              )}
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <p className="truncate font-mono font-medium text-[#d0d6e0]" title={it.filename}>
                                  {it.filename}
                                </p>
                                {it.alreadyArchived ? (
                                  <Badge variant="outline" className="text-[10px] text-[#8a8f98] border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] shrink-0 font-normal">
                                    In Vault
                                  </Badge>
                                ) : it.blacklisted ? (
                                  <Badge className="bg-red-500/15 text-red-400 border border-red-500/30 text-[10px] shrink-0 font-normal">
                                    Bad Password
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="text-[11px] text-[#62666d]">
                                {formatBytes(it.sizeBytes)} · {it.date.slice(0, 10)}
                              </p>
                            </div>

                            <div className="flex items-center gap-1.5 w-44 shrink-0">
                              <span className="text-[10px] text-[#8a8f98] shrink-0">PW:</span>
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
                                className="h-7 font-mono text-[11px] px-2 bg-[#0c0d0e] border-[rgba(255,255,255,0.08)]"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center flex-1 rounded-[8px] border border-[rgba(255,255,255,0.04)] bg-[#08090a] p-8 text-center text-[#8a8f98]">
                    <p className="text-xs">Select a channel and click &ldquo;Scan&rdquo; to discover archives.</p>
                  </div>
                )}

                {/* Footer with summary and action buttons */}
                <div className="shrink-0 flex items-center justify-between gap-3 pt-3 border-t border-[rgba(255,255,255,0.06)]">
                  <div className="text-xs text-[#8a8f98]">
                    {scrapedItems.length > 0 ? (
                      <span>
                        Selected:{" "}
                        <strong className="text-[#f7f8f8]">
                          {scrapedItems.filter((it) => selectedMsgMap[it.messageId]).length}
                        </strong>{" "}
                        archives (
                        {formatBytes(
                          scrapedItems
                            .filter((it) => selectedMsgMap[it.messageId])
                            .reduce((acc, it) => acc + it.sizeBytes, 0)
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
                    >
                      Close
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={handleImportScrapedBatch}
                      disabled={
                        isImportingScraped ||
                        scrapedItems.length === 0 ||
                        scrapedItems.filter((it) => selectedMsgMap[it.messageId]).length === 0
                      }
                      className="gap-1.5"
                    >
                      {isImportingScraped ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                      {isImportingScraped
                        ? "Adding…"
                        : `Add to Server Queue (${scrapedItems.filter((it) => selectedMsgMap[it.messageId]).length})`}
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
