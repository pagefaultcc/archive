"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon3D } from "@/components/kinetics-ui";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { browserListAudit } from "@/lib/api";
import type { AuditEntry, AuditPage } from "@/lib/api";

const ACTIONS = [
  "user.created",
  "user.username_updated",
  "user.password_reset",
  "user.suspended",
  "user.reactivated",
  "user.deleted",
  "user.restored",
  "user.role_assigned",
  "user.role_removed",
  "role.created",
  "role.renamed",
  "role.deleted",
] as const;

const TARGET_TYPES = ["user", "role"] as const;

const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

function formatTimestamp(iso: string): string {
  return `${timestampFormatter.format(new Date(iso))} UTC`;
}

function MetadataPills({ metadata }: { metadata?: Record<string, unknown> | null }) {
  if (!metadata || typeof metadata !== "object") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const pills = Object.keys(metadata)
    .sort()
    .map((key) => ({ key, value: JSON.stringify(metadata[key]) }));
  if (pills.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {pills.map((pill) => (
        <span
          key={pill.key}
          className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
        >
          {pill.key}={pill.value}
        </span>
      ))}
    </div>
  );
}

function filterParams(action: string, targetType: string) {
  return {
    ...(action ? { action } : {}),
    ...(targetType ? { targetType } : {}),
  };
}

export function AuditViewer({ initialPage }: { initialPage: AuditPage }) {
  const [page, setPage] = useState<AuditPage>(initialPage);
  const [entries, setEntries] = useState<AuditEntry[]>(initialPage.entries);
  const [actionFilter, setActionFilter] = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [pending, setPending] = useState<"apply" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(params: {
    action: string;
    targetType: string;
    cursor?: string;
  }) {
    const result = await browserListAudit({
      ...filterParams(params.action, params.targetType),
      ...(params.cursor ? { cursor: params.cursor } : {}),
      limit: 25,
    });
    if (result.ok) {
      setPage(result.data);
      setEntries((current) =>
        params.cursor ? [...current, ...result.data.entries] : result.data.entries,
      );
      setError(null);
      return;
    }
    if (result.status === 401) {
      window.location.assign("/login");
      return;
    }
    setError(
      result.networkError || result.status >= 500
        ? "The service is temporarily unavailable. Try again."
        : result.error?.message ?? "Could not load audit entries.",
    );
    if (params.cursor === undefined) {
      setEntries([]);
      setPage({ entries: [], nextCursor: null, hasMore: false });
    }
  }

  async function applyFilters() {
    setPending("apply");
    await load({ action: actionFilter, targetType: targetTypeFilter });
    setPending(null);
  }

  async function resetFilters() {
    setActionFilter("");
    setTargetTypeFilter("");
    setPending("apply");
    await load({ action: "", targetType: "" });
    setPending(null);
  }

  async function loadMore() {
    setPending("more");
    await load({
      action: actionFilter,
      targetType: targetTypeFilter,
      cursor: page.nextCursor ?? undefined,
    });
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Icon3D name="notebook" size="sm" />
            <h1 className="text-base font-semibold tracking-tight">Audit log</h1>
            <Badge variant="secondary">Append-only trigger enforced</Badge>
          </div>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void applyFilters();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="audit-action">Action</Label>
              <select
                id="audit-action"
                className="block h-9 rounded-md border bg-background px-3 text-sm"
                value={actionFilter}
                onChange={(event) => setActionFilter(event.target.value)}
              >
                <option value="">All actions</option>
                {ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-target-type">Target type</Label>
              <select
                id="audit-target-type"
                className="block h-9 rounded-md border bg-background px-3 text-sm"
                value={targetTypeFilter}
                onChange={(event) => setTargetTypeFilter(event.target.value)}
              >
                <option value="">All targets</option>
                {TARGET_TYPES.map((targetType) => (
                  <option key={targetType} value={targetType}>
                    {targetType}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm" className="spring-interactive" disabled={pending !== null}>
              {pending === "apply" ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : null}
              Apply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="spring-interactive"
              disabled={pending !== null}
              onClick={() => void resetFilters()}
            >
              <RotateCcw aria-hidden /> Reset
            </Button>
          </form>
        </div>
      </Card>

      {error ? (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="hidden overflow-x-auto rounded-lg border border-border/70 bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  #{entry.id}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">
                    {entry.action}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {entry.actorId ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {entry.targetType}:{entry.targetId ?? "—"}
                </TableCell>
                <TableCell className="max-w-xs">
                  <MetadataPills metadata={entry.metadata} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatTimestamp(entry.createdAt)}
                </TableCell>
              </TableRow>
            ))}
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No audit entries match the current filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-3 md:hidden">
        {entries.map((entry) => (
          <Card key={entry.id}>
            <CardContent className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground">#{entry.id}</span>
                <Badge variant="outline" className="font-mono">
                  {entry.action}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatTimestamp(entry.createdAt)}
              </p>
              <p className="font-mono text-xs">
                actor {entry.actorId ?? "—"} → {entry.targetType}:{entry.targetId ?? "—"}
              </p>
              <MetadataPills metadata={entry.metadata} />
            </CardContent>
          </Card>
        ))}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No audit entries match the current filters.
          </p>
        ) : null}
      </div>

      {page.hasMore && page.nextCursor ? (
        <Button
          variant="outline"
          className="spring-interactive"
          disabled={pending !== null}
          onClick={() => void loadMore()}
        >
          {pending === "more" ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}
