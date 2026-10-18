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
import { MotionSurface } from "@/components/motion-surface";
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
      {/* SpinupMail 4-Card Top Telemetry Grid */}
      <MotionSurface busy={isSavingPasswords}>
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-400">
                Uploaded On Disk
              </span>
              <span className="spinup-pill">Packed</span>
            </div>
            <span className="mt-3 text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-white">
              {stats ? formatBytes(packedBytes) : "—"}
            </span>
          </div>

          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-400">
                Uncompressed Size
              </span>
              <span className="spinup-pill">Virtual</span>
            </div>
            <span className="mt-3 text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-white">
              {stats ? formatBytes(uncompressedBytes) : "—"}
            </span>
          </div>

          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-400">
                Compression Ratio
              </span>
              <span className="spinup-pill">Efficiency</span>
            </div>
            <span className="mt-3 text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-white">
              {stats ? `${compressionRatio}x` : "—"}
            </span>
          </div>

          <div className="spinup-card flex flex-col justify-between p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-400">
                Indexed Entries
              </span>
              <span className="spinup-pill">PostgreSQL</span>
            </div>
            <span className="mt-3 text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-white">
              {stats ? (
                <SpringCounter value={Number(stats.totalFiles)} />
              ) : (
                "—"
              )}
            </span>
          </div>
        </section>
      </MotionSurface>

      {/* Storage Breakdown Details Card */}
      <section className="spinup-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-white">
                Storage Architecture Breakdown
              </h2>
              {stats ? (
                <span className="spinup-pill">
                  {stats.totalArchives} {stats.totalArchives === 1 ? "archive" : "archives"}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-neutral-500">
              Detailed accounting of physical files on disk vs virtual uncompressed index size ({stats ? `${formatBytes(diskFree)} available` : "—"}).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lastCleanup !== null ? (
              <span className="spinup-pill font-mono text-xs">
                Freed {formatBytes(lastCleanup.freedBytes)} ({lastCleanup.removedCount} removed)
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void loadStats()}
              disabled={isLoading}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
            >
              <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleCleanupTemp}
              disabled={isCleaning}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
            >
              <Trash2 className="size-3.5" />
              {isCleaning ? "Cleaning…" : "Delete Temp Files"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleReindexEverything}
              disabled={isReindexing}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
            >
              <RotateCcw
                className={cn("size-3.5", isReindexing && "animate-spin")}
              />
              {isReindexing ? "Reindexing…" : "Reindex Everything"}
            </Button>
          </div>
        </div>

        {/* 4 Detail Columns */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-white/[0.06] bg-[#0e0f11] p-3.5">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <HardDrive className="size-3.5 text-neutral-400" />
              <span>Physical Uploads</span>
            </div>
            <p className="font-mono text-base font-semibold text-white">
              {stats ? formatBytes(packedBytes) : "—"}
            </p>
            <p className="break-words text-[11px] text-neutral-500">
              Raw packed .rar, .7z, and .zip files stored in /var/lib/archive/uploads.
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border border-white/[0.06] bg-[#0e0f11] p-3.5">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Layers className="size-3.5 text-neutral-400" />
              <span>Uncompressed Size</span>
            </div>
            <p className="font-mono text-base font-semibold text-white">
              {stats ? formatBytes(uncompressedBytes) : "—"}
            </p>
            <p className="text-[11px] text-neutral-500">
              Total content size if every file inside the archives were extracted to disk ({compressionRatio}x compression).
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border border-white/[0.06] bg-[#0e0f11] p-3.5">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Database className="size-3.5 text-neutral-400" />
              <span>Database &amp; Trigram</span>
            </div>
            <p className="font-mono text-base font-semibold text-white">
              13 GB
            </p>
            <p className="text-[11px] text-neutral-500">
              PostgreSQL index catalog (4.6M file entries + GIN trigram indexes for sub-second search).
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border border-white/[0.06] bg-[#0e0f11] p-3.5">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <HardDrive className="size-3.5 text-neutral-400" />
              <span>Host Filesystem</span>
            </div>
            <p className="font-mono text-base font-semibold text-white">
              {stats ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}` : "—"}
            </p>
            <p className="text-[11px] text-neutral-500">
              Total OS, Docker, and volume allocation on the server partition ({usedPct}% used).
            </p>
          </div>
        </div>

        {/* SpinupMail Linear Capacity Bar */}
        <div className="mt-5 flex h-2 w-full overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className="h-full bg-white/85"
            style={{ width: `${archivePct}%` }}
            title={`Archive Blobs: ${formatBytes(packedBytes)}`}
          />
          <div
            className="h-full bg-white/25"
            style={{ width: `${systemPct}%` }}
            title={`System & Runtime: ${formatBytes(systemUsed)}`}
          />
        </div>

        {/* Minimalist Legend */}
        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-white/[0.06] pt-4 sm:grid-cols-3">
          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-white/85" />
              <span className="text-xs text-neutral-400">Archive Uploads On Disk</span>
            </div>
            <p className="mt-1 font-mono text-sm font-medium tabular-nums text-white">
              {stats ? formatBytes(packedBytes) : "—"}
            </p>
          </div>

          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-white/25" />
              <span className="text-xs text-neutral-400">System &amp; Database</span>
            </div>
            <p className="mt-1 font-mono text-sm font-medium tabular-nums text-white">
              {stats ? formatBytes(systemUsed) : "—"}
            </p>
          </div>

          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full border border-white/[0.2] bg-transparent" />
              <span className="text-xs text-neutral-400">Unallocated Free</span>
            </div>
            <p className="mt-1 font-mono text-sm font-medium tabular-nums text-white">
              {stats ? formatBytes(diskFree) : "—"}
            </p>
          </div>
        </div>
      </section>

      {/* Archive Password Dictionary (ZIP / 7z / RAR Auto-Unlock) */}
      <section className="spinup-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/[0.07] pb-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <Key className="mt-0.5 size-4 shrink-0 text-neutral-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">
                Archive Password Dictionary
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                Probe passwords tried automatically on upload and indexing before prompting the user.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="spinup-pill font-mono text-xs">
              {passwords.length} active passwords
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setIsEditingPasswords((e) => !e);
                setPasswordsText(passwords.join("\n"));
              }}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.04]"
            >
              {isEditingPasswords ? "Close editor" : "Bulk edit (multiline)"}
            </Button>
          </div>
        </div>

        {isEditingPasswords ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-neutral-400">
              Paste or edit passwords below (one password per line). Duplicates and whitespace will be automatically cleaned:
            </p>
            <textarea
              rows={8}
              value={passwordsText}
              onChange={(e) => setPasswordsText(e.target.value)}
              placeholder="@HUNTER_CLOUD&#10;infected&#10;password&#10;1234"
              className="spinup-input w-full p-3 font-mono text-xs"
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
                className="motion-sheen gap-1.5 rounded-lg"
              >
                <Save className="size-3.5" />
                {isSavingPasswords ? "Saving…" : "Save password list"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex max-w-md items-center gap-2">
              <input
                type="text"
                value={newPasswordInput}
                onChange={(e) => setNewPasswordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddSinglePassword();
                }}
                placeholder="Add new password to dictionary…"
                className="spinup-input h-8 min-w-0 flex-1 px-3 font-mono text-xs"
              />
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => void handleAddSinglePassword()}
                disabled={!newPasswordInput.trim() || isSavingPasswords}
                className="motion-sheen gap-1 h-8 rounded-lg"
              >
                <Plus className="size-3" />
                Add
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {passwords.map((pw) => (
                <span
                  key={pw}
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-white/[0.07] bg-[#0e0f11] px-2.5 py-1 font-mono text-xs text-neutral-200"
                >
                  <Lock className="size-3 shrink-0 text-neutral-500" />
                  <span className="truncate" title={pw}>{pw}</span>
                  <button
                    type="button"
                    onClick={() => void handleRemovePassword(pw)}
                    title={`Remove "${pw}" from dictionary`}
                    className="ml-1 shrink-0 text-neutral-500 transition-none hover:text-[#f91880]"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Per-Archive Storage Breakdown Table */}
      <section className="spinup-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <FileArchive className="size-4 shrink-0 text-neutral-400" />
            <h2 className="text-sm font-semibold tracking-tight text-white">
              Per-Archive Storage Breakdown
            </h2>
          </div>
          <span className="spinup-pill">
            {stats
              ? `${stats.totalArchives} archives · ${stats.totalFiles.toLocaleString()} files · ${stats.totalDirs.toLocaleString()} folders`
              : "Loading…"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-white/[0.06] bg-[#0e0f11]/60 hover:bg-transparent">
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Archive Filename</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Format</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Packed On Disk</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Uncompressed Size</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Ratio</TableHead>
                <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">Files</TableHead>
                <TableHead className="py-3 px-4 text-right text-xs font-medium text-neutral-400">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats?.archiveBreakdown && stats.archiveBreakdown.length > 0 ? (
                stats.archiveBreakdown.map((item) => (
                  <TableRow key={item.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <TableCell className="py-3.5 px-4 font-mono text-xs font-medium text-white max-w-[320px] truncate" title={item.filename}>
                      {item.filename}
                    </TableCell>
                    <TableCell className="py-3.5 px-4">
                      <span className="spinup-pill font-mono text-[10px] uppercase">
                        {item.format}
                      </span>
                    </TableCell>
                    <TableCell className="py-3.5 px-4 font-mono text-xs tabular-nums text-neutral-400">
                      {formatBytes(item.packedBytes)}
                    </TableCell>
                    <TableCell className="py-3.5 px-4 font-mono text-xs tabular-nums text-white">
                      {formatBytes(item.uncompressedBytes)}
                    </TableCell>
                    <TableCell className="py-3.5 px-4 font-mono text-xs font-semibold tabular-nums text-[#00ba7c]">
                      {item.ratio}
                    </TableCell>
                    <TableCell className="py-3.5 px-4 font-mono text-xs tabular-nums text-neutral-400">
                      {item.fileCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-3.5 px-4 text-right">
                      <Button asChild variant="ghost" size="xs" className="text-neutral-400 hover:text-white">
                        <Link href={`/archives/${item.id}`} title="Open in File Explorer">
                          <ArrowUpRight className="size-3.5" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : null}
            </TableBody>
          </Table>
          {!stats?.archiveBreakdown?.length ? (
            <div className="px-4 py-10 text-center text-xs text-neutral-500">
              No archives uploaded yet.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
