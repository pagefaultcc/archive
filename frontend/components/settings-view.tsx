"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Database,
  FileArchive,
  HardDrive,
  Key,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Icon3D, SpringCounter } from "@/components/kinetics-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  browserCleanupTempFiles,
  browserGetArchivePasswords,
  browserGetStorageStats,
  browserReindexAllArchives,
  browserUpdateArchivePasswords,
} from "@/lib/api";
import type { GlobalStorageStats } from "@/lib/api";
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

export function SettingsView({
  initialStats,
}: {
  initialStats?: GlobalStorageStats | null;
}) {
  const [stats, setStats] = useState<GlobalStorageStats | null>(
    initialStats ?? null,
  );
  const [isLoading, setIsLoading] = useState(!initialStats);
  const [isReindexing, startReindexTransition] = useTransition();
  const [isCleaning, startCleanTransition] = useTransition();
  const [lastCleanup, setLastCleanup] = useState<{
    freedBytes: number;
    removedCount: number;
  } | null>(null);
  const [passwords, setPasswords] = useState<string[]>([]);
  const [passwordsText, setPasswordsText] = useState("");
  const [isEditingPasswords, setIsEditingPasswords] = useState(false);
  const [isSavingPasswords, setIsSavingPasswords] = useState(false);
  const [newPasswordInput, setNewPasswordInput] = useState("");

  async function loadPasswords() {
    const res = await browserGetArchivePasswords();
    if (res.ok) {
      setPasswords(res.data.passwords);
      setPasswordsText(res.data.passwords.join("\n"));
    }
  }

  useEffect(() => {
    void loadPasswords();
  }, []);

  async function savePasswordsList(list: string[]) {
    setIsSavingPasswords(true);
    const res = await browserUpdateArchivePasswords(list);
    setIsSavingPasswords(false);
    if (res.ok) {
      setPasswords(res.data.passwords);
      setPasswordsText(res.data.passwords.join("\n"));
      setIsEditingPasswords(false);
      toast.success(
        `Saved archive password dictionary (${res.data.passwords.length} passwords).`,
      );
    } else {
      toast.error(res.error?.message ?? "Failed to save archive passwords.");
    }
  }

  async function handleAddSinglePassword() {
    const val = newPasswordInput.trim();
    if (!val) return;
    if (passwords.includes(val)) {
      toast.info("Password is already in the dictionary.");
      return;
    }
    const updated = [...passwords, val];
    setNewPasswordInput("");
    await savePasswordsList(updated);
  }

  async function handleRemovePassword(p: string) {
    const updated = passwords.filter((item) => item !== p);
    await savePasswordsList(updated);
  }

  async function loadStats() {
    setIsLoading(true);
    const res = await browserGetStorageStats();
    setIsLoading(false);
    if (res.ok) {
      setStats(res.data);
    } else {
      toast.error(res.error?.message ?? "Failed to load storage statistics.");
    }
  }

  useEffect(() => {
    if (!initialStats) {
      void loadStats();
    }
  }, [initialStats]);

  function handleReindexEverything() {
    startReindexTransition(async () => {
      toast.info("Reindexing all archives…");
      const res = await browserReindexAllArchives();
      if (res.ok) {
        toast.success(
          `Successfully reindexed ${res.data.reindexed} of ${res.data.total} archives.`,
        );
        void loadStats();
      } else {
        toast.error(res.error?.message ?? "Reindexing failed.");
      }
    });
  }

  function handleCleanupTemp() {
    startCleanTransition(async () => {
      const res = await browserCleanupTempFiles();
      if (res.ok) {
        setLastCleanup(res.data);
        if (res.data.removedCount === 0) {
          toast.success(
            "Storage is clean — 0 B of orphaned temporary files found.",
          );
        } else {
          toast.success(
            `Freed ${formatBytes(res.data.freedBytes)} (${res.data.removedCount} temporary item${res.data.removedCount === 1 ? "" : "s"} deleted).`,
          );
        }
        void loadStats();
      } else {
        toast.error(res.error?.message ?? "Failed to clean temporary files.");
      }
    });
  }

  const diskTotal = Number(stats?.diskTotalBytes ?? 0);
  const diskFree = Number(stats?.diskFreeBytes ?? 0);
  const diskUsed = Number(stats?.diskUsedBytes ?? 0);
  const packedBytes = Number(stats?.totalPackedBytes ?? 0);
  const uncompressedBytes = Number(stats?.totalUncompressedBytes ?? 0);
  const systemUsed = Math.max(0, diskUsed - packedBytes);

  const archivePct =
    diskTotal > 0 ? Math.max(1, (packedBytes / diskTotal) * 100) : 0;
  const systemPct =
    diskTotal > 0 ? Math.max(1, (systemUsed / diskTotal) * 100) : 0;
  const usedPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  const compressionRatio =
    packedBytes > 0
      ? (uncompressedBytes / packedBytes).toFixed(2)
      : "1.00";

  return (
    <div className="flex flex-col gap-6 spring-enter">
      {/* Top Telemetry Strip */}
      <section className="kinetics-card w-full rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <Icon3D name="tools" size="md" />
            <div className="flex flex-col gap-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Server Telemetry
              </p>
              <h2 className="text-sm font-semibold tracking-tight text-[#d0d6e0]">
                Storage &amp; Index
              </h2>
              <span className="text-xs text-[#8a8f98]">
                {stats ? `${formatBytes(diskFree)} available on host` : "Loading…"}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Uploaded On Disk
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                {stats ? formatBytes(packedBytes) : "—"}
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Uncompressed Size
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                {stats ? formatBytes(uncompressedBytes) : "—"}
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Compression Ratio
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                {stats ? `${compressionRatio}x` : "—"}
              </span>
            </div>

            <div className="flex flex-col gap-0.5 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#62666d]">
                Indexed Entries
              </span>
              <span className="text-lg font-semibold tabular-nums tracking-tight text-[#d0d6e0]">
                {stats ? (
                  <SpringCounter value={Number(stats.totalFiles)} />
                ) : (
                  "—"
                )}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold tracking-tight text-[#d0d6e0]">
            Storage Allocation
          </h1>
          {stats ? (
            <Badge variant="secondary">
              {stats.totalArchives}{" "}
              {stats.totalArchives === 1 ? "archive" : "archives"}
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lastCleanup !== null ? (
            <Badge variant="outline" className="font-mono text-xs text-[#8a8f98]">
              Freed {formatBytes(lastCleanup.freedBytes)} ({lastCleanup.removedCount} removed)
            </Badge>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadStats()}
            disabled={isLoading}
            className="gap-1.5"
          >
            <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCleanupTemp}
            disabled={isCleaning}
            className="gap-1.5"
          >
            <Trash2 className="size-3.5" />
            {isCleaning ? "Cleaning…" : "Delete Temp Files"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReindexEverything}
            disabled={isReindexing}
            className="gap-1.5"
          >
            <RotateCcw
              className={cn("size-3.5", isReindexing && "animate-spin")}
            />
            {isReindexing ? "Reindexing…" : "Reindex Everything"}
          </Button>
        </div>
      </div>

      {/* Storage Breakdown Details Card: Explaining Upload vs Uncompressed */}
      <section className="kinetics-card rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] pb-3">
          <div>
            <p className="text-sm font-medium text-[#d0d6e0]">
              Storage Architecture Breakdown
            </p>
            <p className="mt-0.5 text-xs text-[#62666d]">
              Detailed accounting of physical files on disk vs virtual uncompressed index size.
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-[#8a8f98]">
            {stats ? `${formatBytes(diskFree)} available host capacity` : "—"}
          </span>
        </div>

        {/* 4 Detail Columns */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1 rounded-[6px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.01)] p-3">
            <div className="flex items-center gap-2 text-xs text-[#8a8f98]">
              <HardDrive className="size-3.5 text-[#8a8f98]" />
              <span>Physical Uploads</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#d0d6e0]">
              {stats ? formatBytes(packedBytes) : "—"}
            </p>
            <p className="text-[11px] text-[#62666d]">
              Raw packed .rar, .7z, and .zip files stored in /var/lib/archive/uploads.
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-[6px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.01)] p-3">
            <div className="flex items-center gap-2 text-xs text-[#8a8f98]">
              <Layers className="size-3.5 text-[#8a8f98]" />
              <span>Uncompressed Size</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#d0d6e0]">
              {stats ? formatBytes(uncompressedBytes) : "—"}
            </p>
            <p className="text-[11px] text-[#62666d]">
              Total content size if every file inside the archives were extracted to disk ({compressionRatio}x compression).
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-[6px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.01)] p-3">
            <div className="flex items-center gap-2 text-xs text-[#8a8f98]">
              <Database className="size-3.5 text-[#8a8f98]" />
              <span>Database &amp; Trigram</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#d0d6e0]">
              13 GB
            </p>
            <p className="text-[11px] text-[#62666d]">
              PostgreSQL index catalog (4.6M file entries + GIN trigram indexes for sub-second search).
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-[6px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.01)] p-3">
            <div className="flex items-center gap-2 text-xs text-[#8a8f98]">
              <HardDrive className="size-3.5 text-[#8a8f98]" />
              <span>Host Filesystem</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#d0d6e0]">
              {stats ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}` : "—"}
            </p>
            <p className="text-[11px] text-[#62666d]">
              Total OS, Docker, and volume allocation on the 1 TB server partition ({usedPct}% used).
            </p>
          </div>
        </div>

        {/* Subdued Dark-Zinc Segmented Bar */}
        <div className="mt-5 flex h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.04)]">
          <div
            className="h-full bg-[rgba(255,255,255,0.15)]"
            style={{ width: `${archivePct}%` }}
            title={`Archive Blobs: ${formatBytes(packedBytes)}`}
          />
          <div
            className="h-full bg-[rgba(255,255,255,0.06)]"
            style={{ width: `${systemPct}%` }}
            title={`System & Runtime: ${formatBytes(systemUsed)}`}
          />
        </div>

        {/* Minimalist Legend */}
        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-[rgba(255,255,255,0.05)] pt-4 sm:grid-cols-3">
          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[rgba(255,255,255,0.15)]" />
              <span className="text-xs text-[#8a8f98]">Archive Uploads On Disk</span>
            </div>
            <p className="mt-1 font-mono text-sm font-medium tabular-nums text-[#d0d6e0]">
              {stats ? formatBytes(packedBytes) : "—"}
            </p>
          </div>

          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[rgba(255,255,255,0.06)]" />
              <span className="text-xs text-[#8a8f98]">System &amp; Database</span>
            </div>
            <p className="mt-1 font-mono text-sm font-medium tabular-nums text-[#d0d6e0]">
              {stats ? formatBytes(systemUsed) : "—"}
            </p>
          </div>

          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-transparent" />
              <span className="text-xs text-[#8a8f98]">Unallocated Free</span>
            </div>
            <p className="mt-1 font-mono text-sm font-medium tabular-nums text-[#d0d6e0]">
              {stats ? formatBytes(diskFree) : "—"}
            </p>
          </div>
        </div>
      </section>

      {/* Archive Password Dictionary (ZIP / 7z / RAR Auto-Unlock) */}
      <section className="kinetics-card rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[rgba(255,255,255,0.05)] pb-3">
          <div className="flex items-center gap-2.5">
            <Key className="size-4 text-[#d0d6e0]" />
            <div>
              <p className="text-sm font-medium text-[#d0d6e0]">
                Archive Password Dictionary
              </p>
              <p className="mt-0.5 text-xs text-[#62666d]">
                Probe passwords tried automatically on upload and indexing before prompting the user.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono text-xs">
              {passwords.length} active passwords
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setIsEditingPasswords((e) => !e);
                setPasswordsText(passwords.join("\n"));
              }}
              className="gap-1.5"
            >
              {isEditingPasswords ? "Close editor" : "Bulk edit (multiline)"}
            </Button>
          </div>
        </div>

        {isEditingPasswords ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-[#8a8f98]">
              Paste or edit passwords below (one password per line). Duplicates and whitespace will be automatically cleaned:
            </p>
            <textarea
              rows={8}
              value={passwordsText}
              onChange={(e) => setPasswordsText(e.target.value)}
              placeholder="@HUNTER_CLOUD&#10;infected&#10;password&#10;1234"
              className="w-full rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-3 font-mono text-xs text-[#d0d6e0] outline-none focus:border-[rgba(255,255,255,0.2)]"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setIsEditingPasswords(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                size="xs"
                onClick={() => {
                  const lines = passwordsText
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  void savePasswordsList(lines);
                }}
                disabled={isSavingPasswords}
                className="gap-1.5"
              >
                <Save className="size-3.5" />
                {isSavingPasswords ? "Saving…" : "Save password list"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {/* Quick add single password input */}
            <div className="flex max-w-md items-center gap-2">
              <input
                type="text"
                value={newPasswordInput}
                onChange={(e) => setNewPasswordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddSinglePassword();
                }}
                placeholder="Add new password to dictionary…"
                className="h-8 flex-1 rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2.5 font-mono text-xs text-[#d0d6e0] outline-none focus:border-[rgba(255,255,255,0.2)]"
              />
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => void handleAddSinglePassword()}
                disabled={!newPasswordInput.trim() || isSavingPasswords}
                className="gap-1 h-8"
              >
                <Plus className="size-3" />
                Add
              </Button>
            </div>

            {/* Password tags list */}
            <div className="flex flex-wrap items-center gap-2">
              {passwords.map((pw) => (
                <span
                  key={pw}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-2.5 py-1 font-mono text-xs text-[#d0d6e0]"
                >
                  <Lock className="size-3 text-[#8a8f98]" />
                  <span>{pw}</span>
                  <button
                    type="button"
                    onClick={() => void handleRemovePassword(pw)}
                    title={`Remove "${pw}" from dictionary`}
                    className="ml-1 text-[#8a8f98] hover:text-[#f91880]"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Per-Archive Storage Breakdown Table (Replaces File Extensions Table) */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileArchive className="size-4 text-[#8a8f98]" />
            <h2 className="text-sm font-semibold tracking-tight text-[#d0d6e0]">
              Per-Archive Storage Breakdown
            </h2>
          </div>
          <span className="text-xs text-[#62666d]">
            {stats
              ? `${stats.totalArchives} archives · ${stats.totalFiles.toLocaleString()} files · ${stats.totalDirs.toLocaleString()} folders`
              : ""}
          </span>
        </div>

        <div className="rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Archive Filename</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Packed On Disk</TableHead>
                <TableHead>Uncompressed Size</TableHead>
                <TableHead>Ratio</TableHead>
                <TableHead>Files</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats?.archiveBreakdown && stats.archiveBreakdown.length > 0 ? (
                stats.archiveBreakdown.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs font-medium text-[#d0d6e0] max-w-[320px] truncate">
                      {item.filename}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px] uppercase">
                        {item.format}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-[#8a8f98]">
                      {formatBytes(item.packedBytes)}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-[#d0d6e0]">
                      {formatBytes(item.uncompressedBytes)}
                    </TableCell>
                    <TableCell className="font-mono text-xs font-semibold tabular-nums text-[#00ba7c]">
                      {item.ratio}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-[#8a8f98]">
                      {item.fileCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="xs">
                        <Link href={`/archives/${item.id}`} title="Open in File Explorer">
                          <ArrowUpRight className="size-3.5" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-xs text-[#62666d]"
                  >
                    No archives uploaded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
