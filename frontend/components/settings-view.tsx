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
import { Button } from "@/components/ui/button";
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
    queueMicrotask(() => {
      void loadPasswords();
    });
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
      queueMicrotask(() => {
        void loadStats();
      });
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
    packedBytes > 0 ? (uncompressedBytes / packedBytes).toFixed(2) : "1.00";

  return (
    <div className="flex min-w-0 w-full flex-col gap-5">
      {/* Architectural 4-Column Storage Telemetry Ribbon */}
      <section className="obsidian-panel grid grid-cols-2 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Physical On Disk</span>
            <span className="obsidian-pill text-[10px]">Packed</span>
          </div>
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
            {stats ? formatBytes(packedBytes) : "—"}
          </span>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Uncompressed Volume</span>
            <span className="obsidian-pill text-[10px]">Virtual</span>
          </div>
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
            {stats ? formatBytes(uncompressedBytes) : "—"}
          </span>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Compression Ratio</span>
            <span className="obsidian-pill text-[10px]">Density</span>
          </div>
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#10b981]">
            {stats ? `${compressionRatio}x` : "—"}
          </span>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Indexed Entries</span>
            <span className="obsidian-pill text-[10px]">PostgreSQL</span>
          </div>
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
            {stats ? Number(stats.totalFiles).toLocaleString() : "—"}
          </span>
        </div>
      </section>

      {/* Storage Architecture Breakdown */}
      <section className="obsidian-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#f3f4f6]">
                Storage Architecture
              </h2>
              {stats ? (
                <span className="obsidian-pill font-mono text-[10px]">
                  {stats.totalArchives}{" "}
                  {stats.totalArchives === 1 ? "container" : "containers"}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-[#6b707b]">
              Physical volume allocation vs virtual uncompressed index ({stats ? `${formatBytes(diskFree)} free` : "—"}).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lastCleanup !== null ? (
              <span className="obsidian-pill font-mono text-xs text-[#10b981]">
                Freed {formatBytes(lastCleanup.freedBytes)} ({lastCleanup.removedCount} removed)
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void loadStats()}
              disabled={isLoading}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              <RefreshCw
                className={cn("size-3.5", isLoading && "animate-spin")}
              />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleCleanupTemp}
              disabled={isCleaning}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              <Trash2 className="size-3.5" />
              {isCleaning ? "Cleaning…" : "Purge Temp Files"}
            </Button>
            <Button
              type="button"
              size="xs"
              onClick={handleReindexEverything}
              disabled={isReindexing}
              className="h-8 gap-1.5 rounded-lg bg-[#f3f4f6] px-3 text-xs font-medium text-[#050506] hover:bg-white"
            >
              <RotateCcw
                className={cn("size-3.5", isReindexing && "animate-spin")}
              />
              {isReindexing ? "Reindexing…" : "Reindex Everything"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="obsidian-subpanel flex flex-col gap-1 p-3.5">
            <div className="flex items-center gap-2 text-xs text-[#8b909a]">
              <HardDrive className="size-3.5 text-[#5c606a]" />
              <span>Physical Uploads</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#f3f4f6]">
              {stats ? formatBytes(packedBytes) : "—"}
            </p>
            <p className="text-[11px] text-[#6b707b]">
              SHA-256 deduplicated blobs stored in /var/lib/archive/uploads.
            </p>
          </div>

          <div className="obsidian-subpanel flex flex-col gap-1 p-3.5">
            <div className="flex items-center gap-2 text-xs text-[#8b909a]">
              <Layers className="size-3.5 text-[#5c606a]" />
              <span>Uncompressed Size</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#f3f4f6]">
              {stats ? formatBytes(uncompressedBytes) : "—"}
            </p>
            <p className="text-[11px] text-[#6b707b]">
              Virtual extracted size across all indexed containers ({compressionRatio}x).
            </p>
          </div>

          <div className="obsidian-subpanel flex flex-col gap-1 p-3.5">
            <div className="flex items-center gap-2 text-xs text-[#8b909a]">
              <Database className="size-3.5 text-[#5c606a]" />
              <span>PostgreSQL Index</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#f3f4f6]">
              Trigram GIN
            </p>
            <p className="text-[11px] text-[#6b707b]">
              File entries, root-normalized cookie domains, and URL credentials.
            </p>
          </div>

          <div className="obsidian-subpanel flex flex-col gap-1 p-3.5">
            <div className="flex items-center gap-2 text-xs text-[#8b909a]">
              <HardDrive className="size-3.5 text-[#5c606a]" />
              <span>Host Partition</span>
            </div>
            <p className="font-mono text-base font-semibold text-[#f3f4f6]">
              {stats
                ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
                : "—"}
            </p>
            <p className="text-[11px] text-[#6b707b]">
              Total host filesystem utilization ({usedPct}% used).
            </p>
          </div>
        </div>

        {/* Capacity Bar */}
        <div className="mt-5 flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full bg-[#f3f4f6]"
            style={{ width: `${archivePct}%` }}
            title={`Archive Blobs: ${formatBytes(packedBytes)}`}
          />
          <div
            className="h-full bg-white/30"
            style={{ width: `${systemPct}%` }}
            title={`System & Database: ${formatBytes(systemUsed)}`}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-white/[0.06] pt-4 sm:grid-cols-3">
          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[#f3f4f6]" />
              <span className="text-xs text-[#8b909a]">Archive Uploads</span>
            </div>
            <p className="mt-1 font-mono text-xs font-medium tabular-nums text-[#f3f4f6]">
              {stats ? formatBytes(packedBytes) : "—"}
            </p>
          </div>

          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-white/30" />
              <span className="text-xs text-[#8b909a]">System &amp; Index</span>
            </div>
            <p className="mt-1 font-mono text-xs font-medium tabular-nums text-[#f3f4f6]">
              {stats ? formatBytes(systemUsed) : "—"}
            </p>
          </div>

          <div className="flex items-center justify-between sm:block">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full border border-white/25" />
              <span className="text-xs text-[#8b909a]">Available Free</span>
            </div>
            <p className="mt-1 font-mono text-xs font-medium tabular-nums text-[#f3f4f6]">
              {stats ? formatBytes(diskFree) : "—"}
            </p>
          </div>
        </div>
      </section>

      {/* Password Dictionary */}
      <section className="obsidian-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3.5">
          <div className="flex items-start gap-2.5">
            <Key className="mt-0.5 size-4 shrink-0 text-[#8b909a]" />
            <div>
              <h2 className="text-sm font-semibold text-[#f3f4f6]">
                Archive Password Dictionary
              </h2>
              <p className="mt-0.5 text-xs text-[#6b707b]">
                Candidate passwords probed automatically during archive indexing and extraction.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="obsidian-pill font-mono text-xs">
              {passwords.length} passwords
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setIsEditingPasswords((e) => !e);
                setPasswordsText(passwords.join("\n"));
              }}
              className="h-8 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
            >
              {isEditingPasswords ? "Close Editor" : "Bulk Edit"}
            </Button>
          </div>
        </div>

        {isEditingPasswords ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-[#8b909a]">
              Enter one password per line:
            </p>
            <textarea
              rows={8}
              value={passwordsText}
              onChange={(e) => setPasswordsText(e.target.value)}
              placeholder="@HUNTER_CLOUD&#10;infected&#10;password&#10;1234"
              className="obsidian-input w-full p-3 font-mono text-xs"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setIsEditingPasswords(false)}
                className="h-8 text-xs text-[#8b909a]"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                onClick={() => {
                  const lines = passwordsText
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  void savePasswordsList(lines);
                }}
                disabled={isSavingPasswords}
                className="h-8 gap-1.5 rounded-lg bg-[#f3f4f6] px-3.5 text-xs font-medium text-[#050506] hover:bg-white"
              >
                <Save className="size-3.5" />
                {isSavingPasswords ? "Saving…" : "Save Dictionary"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3.5">
            <div className="flex max-w-md items-center gap-2">
              <input
                type="text"
                value={newPasswordInput}
                onChange={(e) => setNewPasswordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddSinglePassword();
                }}
                placeholder="Add password to dictionary…"
                className="obsidian-input h-8 min-w-0 flex-1 px-3 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void handleAddSinglePassword()}
                disabled={!newPasswordInput.trim() || isSavingPasswords}
                className="h-8 gap-1 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#f3f4f6]"
              >
                <Plus className="size-3" />
                Add
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {passwords.map((pw) => (
                <span
                  key={pw}
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-white/[0.07] bg-[#101216] px-2.5 py-1 font-mono text-xs text-[#e5e7eb]"
                >
                  <Lock className="size-3 shrink-0 text-[#5c606a]" />
                  <span className="truncate" title={pw}>
                    {pw}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRemovePassword(pw)}
                    title={`Remove "${pw}"`}
                    className="ml-0.5 shrink-0 text-[#6b707b] hover:text-[#f43f5e] cursor-pointer"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Per-Archive Breakdown Ledger */}
      <section className="obsidian-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <FileArchive className="size-4 text-[#8b909a]" />
            <h2 className="text-sm font-semibold text-[#f3f4f6]">
              Per-Container Storage Breakdown
            </h2>
          </div>
          <span className="obsidian-pill font-mono text-[10px]">
            {stats
              ? `${stats.totalArchives} containers · ${stats.totalFiles.toLocaleString()} files`
              : "Loading…"}
          </span>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[740px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/[0.06] bg-[#101216]/70 text-[11px] font-medium text-[#8b909a]">
                <th className="py-2.5 px-4 font-medium">Container Filename</th>
                <th className="py-2.5 px-4 font-medium">Format</th>
                <th className="py-2.5 px-4 font-medium">Packed</th>
                <th className="py-2.5 px-4 font-medium">Uncompressed</th>
                <th className="py-2.5 px-4 font-medium">Ratio</th>
                <th className="py-2.5 px-4 font-medium">Files</th>
                <th className="py-2.5 px-4 text-right font-medium">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {stats?.archiveBreakdown && stats.archiveBreakdown.length > 0
                ? stats.archiveBreakdown.map((item) => (
                    <tr
                      key={item.id}
                      className="transition-colors hover:bg-white/[0.02]"
                    >
                      <td
                        className="max-w-[320px] truncate py-3 px-4 font-mono text-xs font-medium text-[#f3f4f6]"
                        title={item.filename}
                      >
                        {item.filename}
                      </td>
                      <td className="py-3 px-4">
                        <span className="obsidian-pill font-mono text-[10px] uppercase">
                          {item.format}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs tabular-nums text-[#8b909a]">
                        {formatBytes(item.packedBytes)}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs tabular-nums text-[#f3f4f6]">
                        {formatBytes(item.uncompressedBytes)}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs font-semibold tabular-nums text-[#10b981]">
                        {item.ratio}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs tabular-nums text-[#8b909a]">
                        {item.fileCount.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          asChild
                          variant="ghost"
                          size="xs"
                          className="h-7 w-7 p-0 text-[#8b909a] hover:text-white"
                        >
                          <Link
                            href={`/archives/${item.id}`}
                            title="Open in Archive Inspector"
                          >
                            <ArrowUpRight className="size-3.5" />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
          {!stats?.archiveBreakdown?.length ? (
            <div className="py-10 text-center text-xs text-[#6b707b]">
              No containers uploaded yet.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
