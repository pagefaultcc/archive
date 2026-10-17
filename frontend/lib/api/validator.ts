import { jsonInit, request } from "./core";

export type ValidationItem = {
  id: string;
  service: string;
  domain: string;
  archiveId?: string;
  archiveFilename: string;
  entryPath: string;
  cookieCount: number;
  cookieText: string;
  status: "not_checked" | "valid" | "not_valid";
  checkedAt?: string;
  errorMessage?: string;
  createdAt: string;
};

export type ValidationSummary = {
  total: number;
  notChecked: number;
  valid: number;
  notValid: number;
};

export function browserListValidationItems(service = "chatgpt", status = "", limit = 100, offset = 0) {
  const p = new URLSearchParams();
  if (service) p.set("service", service);
  if (status) p.set("status", status);
  if (limit) p.set("limit", String(limit));
  if (offset) p.set("offset", String(offset));
  return request<{
    service: string;
    status: string;
    items: ValidationItem[];
    summary: ValidationSummary;
    limit: number;
    offset: number;
  }>(`/api/validator?${p.toString()}`, { method: "GET" });
}

export function browserAddValidationDomain(domain: string, service = "chatgpt") {
  return request<{ status: string; addedCount: number; message: string }>(
    "/api/validator/domain",
    jsonInit("POST", { domain, service })
  );
}

export function browserAddValidationLog(logId: number, service = "chatgpt") {
  return request<{ status: string; id: string }>(
    "/api/validator/log",
    jsonInit("POST", { logId, service })
  );
}

export function browserAddValidationCustom(input: { domain: string; service?: string; cookieText: string }) {
  return request<{ status: string; id: string }>(
    "/api/validator/custom",
    jsonInit("POST", input)
  );
}

export function browserCheckValidation(service = "chatgpt", ids?: string[]) {
  return request<{ status: string; checkedCount: number }>(
    "/api/validator/check",
    jsonInit("POST", { service, ids: ids ?? [] })
  );
}

export function browserClearValidation(service = "chatgpt") {
  return request<{ status: string; cleared: boolean }>(
    `/api/validator?service=${encodeURIComponent(service)}`,
    { method: "DELETE" }
  );
}

export function validatorExportUrl(service = "chatgpt"): string {
  return `/api/validator/export?service=${encodeURIComponent(service)}`;
}
