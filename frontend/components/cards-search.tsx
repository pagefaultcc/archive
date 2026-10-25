"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Filter,
  Loader2,
  RotateCcw,
  Search,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  browserReindexCards,
  browserSearchCards,
  type CardItem,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/utils";

const PAGE_SIZE = 200;

function formatCardNumber(num: string, reveal: boolean): string {
  const digits = num.replace(/\D/g, "");
  if (!reveal) {
    if (digits.length <= 4) return "••••";
    const last4 = digits.slice(-4);
    const maskedLength = digits.length - 4;
    const blocks: string[] = [];
    let count = 0;
    let cur = "";
    for (let i = 0; i < maskedLength; i++) {
      cur += "•";
      count++;
      if (count === 4) {
        blocks.push(cur);
        cur = "";
        count = 0;
      }
    }
    if (cur) blocks.push(cur);
    blocks.push(last4);
    return blocks.join(" ");
  }
  // Group digits by 4
  return digits.replace(/(\d{4})/g, "$1 ").trim();
}

function formatExpiration(month: string, year: string): string {
  if (!month && !year) return "—";
  if (month && year) {
    return `${month.padStart(2, "0")}/${year.slice(-2)}`;
  }
  return month ? `${month}/—` : `—/${year}`;
}

const BIN_PRESETS = [
  { label: "All Cards", query: "" },
  { label: "BIN 515462", query: "515462" },
  { label: "BIN 542432", query: "542432" },
  { label: "BIN 411122", query: "411122" },
  { label: "Visa (4)", query: "4" },
  { label: "Mastercard (5)", query: "5" },
];

export function CardsSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CardItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [vaultTotal, setVaultTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchDurationMs, setSearchDurationMs] = useState<number | null>(null);
  const [showCards, setShowCards] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchAbortRef = useRef<AbortController | null>(null);
  const offsetRef = useRef(0);
  const qRef = useRef(q);
  useEffect(() => {
    qRef.current = q;
  }, [q]);

  const executeSearch = useCallback(async (queryOverride?: string) => {
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;

    setIsSearching(true);
    const query = (
      queryOverride !== undefined ? queryOverride : qRef.current
    ).trim();
    const t0 = performance.now();

    try {
      const res = await browserSearchCards(
        {
          q: query || undefined,
          limit: PAGE_SIZE,
          offset: 0,
        },
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || (!res.ok && res.aborted)) return;
      const dt = Math.round(performance.now() - t0);
      setSearchDurationMs(dt);

      if (res.ok) {
        setResults(res.data.results);
        setTotalCount(res.data.totalCount);
        if (res.data.vaultTotal !== undefined) {
          setVaultTotal(res.data.vaultTotal);
        } else if (!query) {
          setVaultTotal(res.data.totalCount);
        }
        setHasMore(res.data.hasMore);
        offsetRef.current = res.data.results.length;
      } else {
        toast.error(res.error?.message ?? "Failed to search credit cards.");
      }
    } catch {
      // Aborted or network error
    } finally {
      if (!ctrl.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    const query = qRef.current.trim();

    try {
      const res = await browserSearchCards({
        q: query || undefined,
        limit: PAGE_SIZE,
        offset: offsetRef.current,
      });

      if (res.ok) {
        setResults((prev) => [...prev, ...res.data.results]);
        setTotalCount(res.data.totalCount);
        if (res.data.vaultTotal !== undefined) {
          setVaultTotal(res.data.vaultTotal);
        }
        setHasMore(res.data.hasMore);
        offsetRef.current += res.data.results.length;
      } else {
        toast.error(res.error?.message ?? "Failed to load more cards.");
      }
    } catch {
      toast.error("Failed to load more cards.");
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore]);

  const handleQueryChange = (val: string) => {
    setQ(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      void executeSearch(val);
    }, 250);
  };

  const applyPreset = (presetQuery: string) => {
    setQ(presetQuery);
    clearTimeout(searchTimerRef.current);
    void executeSearch(presetQuery);
  };

  useEffect(() => {
    queueMicrotask(() => {
      void executeSearch("");
    });
    return () => {
      searchAbortRef.current?.abort();
      clearTimeout(searchTimerRef.current);
    };
  }, [executeSearch]);

  const copyRow = async (item: CardItem) => {
    const text = [
      `Card: ${item.number}`,
      item.holder ? `Holder: ${item.holder}` : "",
      item.expMonth || item.expYear ? `Exp: ${item.expMonth}/${item.expYear}` : "",
      item.cvv ? `CVV: ${item.cvv}` : "",
      item.brand ? `Brand: ${item.brand}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1500);
      toast.success("Card record copied.");
    }
  };

  const copyNumberOnly = async (num: string) => {
    const ok = await copyToClipboard(num);
    if (ok) {
      toast.success("Card number copied.");
    }
  };

  const [isReindexing, setIsReindexing] = useState(false);

  const handleReindex = async () => {
    if (isReindexing) return;
    setIsReindexing(true);
    try {
      const res = await browserReindexCards();
      if (res.ok) {
        toast.success("Card re-indexing started across all archives in the vault.");
        setTimeout(() => void executeSearch(qRef.current), 2000);
        setTimeout(() => void executeSearch(qRef.current), 5000);
        setTimeout(() => {
          void executeSearch(qRef.current);
          setIsReindexing(false);
        }, 10000);
      } else {
        toast.error(res.error?.message ?? "Failed to start card re-indexing.");
        setIsReindexing(false);
      }
    } catch {
      toast.error("Failed to start card re-indexing.");
      setIsReindexing(false);
    }
  };

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-4">
      {/* Telemetry Ribbon */}
      <section className="obsidian-panel grid grid-cols-1 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Total Vault Cards</span>
            <CreditCard className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {(vaultTotal ?? totalCount).toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">indexed cards</span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Matching Filter</span>
            <Filter className="size-3.5 text-[#5c606a]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
              {totalCount.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#6b707b]">
              {q.trim() ? "matching cards" : "all displayed"}
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs text-[#8b909a]">
            <span className="font-medium">Query Latency</span>
            <span className="obsidian-pill font-mono text-[10px] text-[#10b981]">
              Zero-Extraction
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#10b981]">
              {searchDurationMs !== null ? `${searchDurationMs} ms` : "—"}
            </span>
            <span className="text-[11px] text-[#6b707b]">Trigram index</span>
          </div>
        </div>
      </section>

      {/* Card Search Command Bar */}
      <section className="obsidian-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 min-w-0 basis-full items-center gap-2.5 rounded-lg border border-white/[0.08] bg-[#101216] px-3 focus-within:border-white/20 sm:flex-1 sm:basis-0">
            <Search className="size-3.5 shrink-0 text-[#6b707b]" />
            <input
              type="search"
              value={q}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  clearTimeout(searchTimerRef.current);
                  void executeSearch(q);
                }
              }}
              aria-label="Filter cards by BIN or card number"
              aria-describedby="card-search-hint"
              placeholder="Filter by BIN (e.g. 515462) or partial card number (e.g. 5424322339)..."
              className="min-w-0 w-full bg-transparent font-mono text-xs text-[#f3f4f6] outline-none placeholder:text-[#5c606a]"
            />
            {q ? (
              <button
                type="button"
                onClick={() => applyPreset("")}
                aria-label="Clear search"
                className="text-[#6b707b] hover:text-[#f3f4f6] cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowCards((s) => !s)}
            aria-pressed={showCards}
            className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#c8ccd4] transition-colors duration-150 hover:bg-white/[0.05] hover:text-white hover:scale-100 active:scale-100 transform-none select-none"
          >
            {showCards ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
            {showCards ? "Mask Numbers" : "Reveal Numbers"}
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={() => {
              clearTimeout(searchTimerRef.current);
              void executeSearch(q);
            }}
            disabled={isSearching}
            className="h-9 gap-1.5 rounded-lg bg-[#f3f4f6] px-4 text-xs font-medium text-[#050506] hover:bg-white hover:scale-100 active:scale-100 transform-none select-none"
          >
            {isSearching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Search
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleReindex()}
            disabled={isReindexing}
            title="Re-extract cards from all archives in the vault"
            aria-label="Reindex cards across vault"
            className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#c8ccd4] transition-colors duration-150 hover:bg-white/[0.05] hover:text-white hover:scale-100 active:scale-100 transform-none select-none"
          >
            <RotateCcw className={`size-3.5 ${isReindexing ? "animate-spin text-[#10b981]" : "text-[#8b909a]"}`} />
            {isReindexing ? "Reindexing..." : "Reindex"}
          </Button>
        </div>

        {/* Quick BIN Preset Chips */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] font-medium text-[#6b707b] mr-1">
            Presets:
          </span>
          {BIN_PRESETS.map((preset) => {
            const isSelected = q === preset.query;
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset.query)}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer ${
                  isSelected
                    ? "border border-white/20 bg-white/10 text-white font-medium"
                    : "border border-white/[0.06] bg-[#101216] text-[#8b909a] hover:border-white/10 hover:text-[#f3f4f6]"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <p id="card-search-hint" className="text-xs text-[#8b909a]">
          Indexed from stealer logs (Cards.txt, CreditCards, and autofill stores). Normally shows all cards; search filters by 6-digit BIN or partial card number.
        </p>

        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#8b909a]">
          <span>
            Showing{" "}
            <strong className="text-[#f3f4f6]">
              {results.length.toLocaleString()}
            </strong>{" "}
            of{" "}
            <strong className="text-[#f3f4f6]">
              {totalCount.toLocaleString()}
            </strong>{" "}
            {q.trim() ? "matching cards" : "cards"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3 text-[#10b981]" />
            {searchDurationMs !== null ? `${searchDurationMs} ms` : "—"}
          </span>
        </div>
      </section>

      {/* Cards Ledger */}
      <section className="obsidian-panel flex min-w-0 flex-col overflow-hidden">
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/[0.06] bg-[#101216]/70 text-[11px] font-medium text-[#8b909a]">
                <th className="py-2.5 px-4 font-medium w-[130px]">Brand</th>
                <th className="py-2.5 px-4 font-medium min-w-[210px]">Card Number</th>
                <th className="py-2.5 px-4 font-medium min-w-[160px]">Cardholder</th>
                <th className="py-2.5 px-4 font-medium w-[90px]">Exp</th>
                <th className="py-2.5 px-4 font-medium w-[80px]">CVV</th>
                <th className="py-2.5 px-4 font-medium min-w-[180px]">Source Archive</th>
                <th className="py-2.5 px-4 font-medium w-[70px] text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {results.map((item) => (
                <tr
                  key={item.id}
                  className="transition-colors hover:bg-white/[0.02]"
                >
                  <td className="py-2.5 px-4">
                    <Badge
                      variant="outline"
                      className="border-white/[0.08] bg-white/[0.02] text-[10px] font-mono text-[#d0d6e0]"
                    >
                      {item.brand || "Card"}
                    </Badge>
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2">
                      <CreditCard className="size-3.5 shrink-0 text-[#6b707b]" />
                      <span className="font-mono text-xs font-semibold tracking-wide text-[#f3f4f6]">
                        {formatCardNumber(item.number, showCards)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyNumberOnly(item.number)}
                        title="Copy card number"
                        aria-label="Copy card number"
                        className="text-[#6b707b] hover:text-[#f3f4f6] cursor-pointer"
                      >
                        <Copy className="size-3" />
                      </button>
                    </div>
                  </td>
                  <td className="py-2.5 px-4">
                    <span className="text-xs text-[#d0d6e0]">
                      {item.holder || "—"}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-xs text-[#8b909a]">
                    {formatExpiration(item.expMonth, item.expYear)}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-xs text-[#8b909a]">
                    {item.cvv ? (showCards ? item.cvv : "•••") : "—"}
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={`/archives/${item.archiveId}`}
                        className="truncate text-xs font-medium text-[#c8ccd4] hover:text-white hover:underline max-w-[240px]"
                        title={item.archiveFilename}
                      >
                        {item.archiveFilename}
                      </Link>
                      <Link
                        href={`/archives/${item.archiveId}?preview=${encodeURIComponent(item.entryPath)}`}
                        className="truncate font-mono text-[10px] text-[#5c606a] hover:text-[#8b909a] max-w-[240px]"
                        title={item.entryPath}
                      >
                        {item.entryPath}
                      </Link>
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => void copyRow(item)}
                      title="Copy card record"
                      aria-label="Copy card record"
                      className="size-7 text-[#8b909a] hover:bg-white/[0.06] hover:text-white hover:scale-100 active:scale-100 transform-none"
                    >
                      {copiedId === item.id ? (
                        <Check className="size-3.5 text-[#10b981]" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
              {results.length === 0 && !isSearching ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-14 text-center text-xs text-[#8b909a]"
                  >
                    <div className="flex flex-col items-center justify-center gap-2">
                      <CreditCard className="size-6 text-[#5c606a]" />
                      <p className="font-medium text-[#f3f4f6]">
                        {q.trim()
                          ? `No cards found matching BIN "${q}".`
                          : "No credit cards indexed in vault."}
                      </p>
                      {q.trim() ? (
                        <button
                          type="button"
                          onClick={() => applyPreset("")}
                          className="mt-1 text-xs text-[#c8ccd4] underline hover:text-white cursor-pointer"
                        >
                          Clear filter and show all cards
                        </button>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <p className="text-[#5c606a]">
                            No cards indexed yet. Click Reindex to scan all existing archives in your vault.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleReindex()}
                            disabled={isReindexing}
                            className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-4 text-xs text-[#c8ccd4] transition-colors hover:bg-white/[0.04] hover:text-white hover:scale-100 active:scale-100 transform-none"
                          >
                            <RotateCcw className={`size-3.5 ${isReindexing ? "animate-spin text-[#10b981]" : "text-[#8b909a]"}`} />
                            {isReindexing ? "Scanning vault archives..." : "Reindex Vault Cards"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {hasMore ? (
          <div className="flex items-center justify-center border-t border-white/[0.06] p-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadMore()}
              disabled={isLoadingMore}
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-4 text-xs text-[#c8ccd4] transition-colors hover:bg-white/[0.04] hover:text-white hover:scale-100 active:scale-100 transform-none"
            >
              {isLoadingMore ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              Load More
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
