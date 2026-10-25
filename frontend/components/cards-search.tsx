"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Loader2,
  Search,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  browserSearchCards,
  type CardItem,
} from "@/lib/api";
import { cn, copyToClipboard } from "@/lib/utils";

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

export function CardsSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CardItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchDurationMs, setSearchDurationMs] = useState<number | null>(null);
  const [showCards, setShowCards] = useState(false);

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
      toast.success("Card data copied to clipboard.");
    }
  };

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-4">
      {/* Card Search Command Bar */}
      <section className="obsidian-panel flex flex-col gap-2.5 p-4">
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
              aria-label="Search cards by holder name, card number, or brand"
              aria-describedby="card-search-hint"
              placeholder="Filter by card number, cardholder, or brand..."
              className="min-w-0 w-full bg-transparent font-mono text-xs text-[#f3f4f6] outline-none placeholder:text-[#5c606a]"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowCards((s) => !s)}
            aria-pressed={showCards}
            className="h-9 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#c8ccd4] hover:bg-white/[0.04] hover:text-white"
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
            className="h-9 gap-1.5 rounded-lg bg-[#f3f4f6] px-4 text-xs font-medium text-[#050506] hover:bg-white"
          >
            {isSearching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Search
          </Button>
        </div>
        <p id="card-search-hint" className="text-xs text-[#8b909a]">
          Indexed from stealer logs across Cards.txt, CreditCards, and autofill stores.
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
            cards
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
                <th className="py-2.5 px-4 font-medium w-[120px]">Brand</th>
                <th className="py-2.5 px-4 font-medium min-w-[200px]">Card Number</th>
                <th className="py-2.5 px-4 font-medium min-w-[160px]">Cardholder</th>
                <th className="py-2.5 px-4 font-medium w-[90px]">Exp</th>
                <th className="py-2.5 px-4 font-medium w-[80px]">CVV</th>
                <th className="py-2.5 px-4 font-medium min-w-[180px]">Source Archive</th>
                <th className="py-2.5 px-4 font-medium w-[60px] text-right">Actions</th>
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
                      className="size-7 text-[#8b909a] hover:bg-white/[0.06] hover:text-white"
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
              {results.length === 0 && !isSearching ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-12 text-center text-xs text-[#5c606a]"
                  >
                    No credit card records found.
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
              className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-4 text-xs text-[#c8ccd4] hover:bg-white/[0.04] hover:text-white"
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
