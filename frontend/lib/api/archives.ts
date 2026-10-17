import {
  internalApiUrl,
  jsonInit,
  parseErrorEnvelope,
  request,
  serverHeaders,
  type ApiResult,
} from "./core";

export type ArchiveFormat = "zip" | "7z" | "rar";

export type ArchiveStatus = "indexed" | "password_required" | "failed";

export type ArchiveItem = {
  id: string;
  ownerId: string;
  ownerUsername: string;
  filename: string;
  format: ArchiveFormat;
  sizeBytes: number;
  sha256: string;
  isEncrypted: boolean;
  status: ArchiveStatus;
  fileCount: number;
  dirCount: number;
  uncompressedBytes: number;
  createdAt: string;
};

export type ArchiveEntry = {
  id: number;
  path: string;
  parentPath: string;
  name: string;
  isDir: boolean;
  sizeBytes: number;
  packedBytes: number;
  crc32: string;
  encrypted: boolean;
  modifiedAt: string | null;
};

export type ArchiveDetail = {
  archive: ArchiveItem;
  entries: ArchiveEntry[];
  parentPath: string;
  query: string;
};

export type ArchiveFilePreview = {
  entry: ArchiveEntry;
  kind: "text" | "image" | "binary";
  mimeType: string;
  text?: string;
  base64Data?: string;
  hexPreview?: string;
  truncated: boolean;
};

export function browserListArchives() {
  return request<{ archives: ArchiveItem[] }>("/api/archives", {
    method: "GET",
  });
}

export function browserGetArchive(
  archiveId: string,
  params?: { parent?: string; q?: string },
  options?: AbortSignal | { signal?: AbortSignal },
) {
  const signal =
    options && "aborted" in options ? options : options?.signal;
  const qs = new URLSearchParams();
  if (params?.parent !== undefined) qs.set("parent", params.parent);
  if (params?.q) qs.set("q", params.q);
  const query = qs.toString();
  return request<ArchiveDetail>(
    `/api/archives/${encodeURIComponent(archiveId)}${query ? `?${query}` : ""}`,
    { method: "GET", signal },
  );
}

export function browserPreviewArchiveFile(
  archiveId: string,
  path: string,
  options?: AbortSignal | { signal?: AbortSignal },
) {
  const signal =
    options && "aborted" in options ? options : options?.signal;
  const qs = new URLSearchParams({ path });
  return request<ArchiveFilePreview>(
    `/api/archives/${encodeURIComponent(archiveId)}/file?${qs.toString()}`,
    { method: "GET", signal },
  );
}

export function archiveDownloadUrl(
  archiveId: string,
  path: string,
  asZip = false,
): string {
  const qs = new URLSearchParams({ path });
  if (asZip) qs.set("zip", "1");
  return `/api/archives/${encodeURIComponent(archiveId)}/download?${qs.toString()}`;
}

export function browserUnlockArchive(archiveId: string, password: string) {
  return request<{ archive: ArchiveItem }>(
    `/api/archives/${encodeURIComponent(archiveId)}/unlock`,
    jsonInit("POST", { password }),
  );
}

export function browserDeleteArchive(archiveId: string) {
  return request<void>(`/api/archives/${encodeURIComponent(archiveId)}`, {
    method: "DELETE",
  });
}

export function browserReindexAllArchives() {
  return request<{ reindexed: number; total: number; errors: string[] }>(
    "/api/archives/reindex",
    { method: "POST" },
  );
}

export function browserReindexArchive(archiveId: string) {
  return request<{ archive: ArchiveItem }>(
    `/api/archives/${encodeURIComponent(archiveId)}/reindex`,
    { method: "POST" },
  );
}

export function browserUploadArchiveWithProgress(input: {
  file: File;
  password?: string;
  onProgress?: (progress: {
    loaded: number;
    total: number;
    percent: number;
    stage: "uploading" | "indexing";
  }) => void;
}): Promise<
  ApiResult<{ archive: ArchiveItem; passwordRequired?: boolean; autoUnlocked?: boolean }>
> {
  const { promise, resolve } =
    Promise.withResolvers<
      ApiResult<{ archive: ArchiveItem; passwordRequired?: boolean; autoUnlocked?: boolean }>
    >();
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/archives", true);

  xhr.upload.onprogress = (event) => {
    if (!input.onProgress) return;
    const total =
      event.lengthComputable && event.total > 0
        ? event.total
        : input.file.size || 1;
    const loaded = Math.min(event.loaded, total);
    const percent = Math.min(95, Math.round((loaded / total) * 95));
    input.onProgress({
      loaded,
      total,
      percent,
      stage: loaded >= total ? "indexing" : "uploading",
    });
  };

  xhr.upload.onload = () => {
    input.onProgress?.({
      loaded: input.file.size,
      total: input.file.size || 1,
      percent: 96,
      stage: "indexing",
    });
  };

  xhr.onerror = () => {
    resolve({ ok: false, status: 0, error: null, networkError: true });
  };

  xhr.onload = () => {
    let body: unknown = null;
    try {
      body = JSON.parse(xhr.responseText);
    } catch {
      body = null;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      input.onProgress?.({
        loaded: input.file.size,
        total: input.file.size || 1,
        percent: 100,
        stage: "indexing",
      });
      resolve({
        ok: true,
        data: body as { archive: ArchiveItem; passwordRequired?: boolean },
      });
      return;
    }
    resolve({
      ok: false,
      status: xhr.status,
      error: parseErrorEnvelope(body),
    });
  };

  const formData = new FormData();
  formData.append("file", input.file);
  if (input.password && input.password.length > 0) {
    formData.append("password", input.password);
  }
  xhr.send(formData);
  return promise;
}

export async function serverListArchives(
  cookieHeader: string | undefined,
): Promise<ApiResult<{ archives: ArchiveItem[] }>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  return request<{ archives: ArchiveItem[] }>(`${baseUrl}/api/archives`, {
    headers: serverHeaders(cookieHeader),
  });
}

export async function serverGetArchiveDetail(
  cookieHeader: string | undefined,
  archiveId: string,
  params?: { parent?: string; q?: string },
): Promise<ApiResult<ArchiveDetail>> {
  let baseUrl: string;
  try {
    baseUrl = internalApiUrl();
  } catch {
    return { ok: false, status: 0, error: null, networkError: true };
  }
  const qs = new URLSearchParams();
  if (params?.parent !== undefined) qs.set("parent", params.parent);
  if (params?.q) qs.set("q", params.q);
  const query = qs.toString();
  return request<ArchiveDetail>(
    `${baseUrl}/api/archives/${encodeURIComponent(archiveId)}${query ? `?${query}` : ""}`,
    { headers: serverHeaders(cookieHeader) },
  );
}
