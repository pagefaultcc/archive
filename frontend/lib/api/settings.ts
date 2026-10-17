import { jsonInit, request } from "./core";

export type StorageTypeStat = {
  extension: string;
  count: number;
  sizeBytes: number;
};

export type StorageFormatStat = {
  format: string;
  count: number;
  sizeBytes: number;
};

export type ArchiveSizeBreakdown = {
  id: string;
  filename: string;
  format: string;
  packedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  dirCount: number;
  ratio: string;
};

export type GlobalStorageStats = {
  totalArchives: number;
  totalPackedBytes: number;
  totalUncompressedBytes: number;
  totalFiles: number;
  totalDirs: number;
  encryptedVaults: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
  formatDistribution: StorageFormatStat[];
  archiveBreakdown: ArchiveSizeBreakdown[];
};

export function browserGetStorageStats() {
  return request<GlobalStorageStats>("/api/settings/storage", {
    method: "GET",
  });
}

export function browserCleanupTempFiles() {
  return request<{ freedBytes: number; removedCount: number }>(
    "/api/settings/cleanup-temp",
    { method: "POST" },
  );
}

export function browserGetArchivePasswords() {
  return request<{ passwords: string[] }>("/api/settings/passwords", {
    method: "GET",
  });
}

export function browserUpdateArchivePasswords(passwords: string[]) {
  return request<{ passwords: string[] }>(
    "/api/settings/passwords",
    jsonInit("PUT", { passwords }),
  );
}
