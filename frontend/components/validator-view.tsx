"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Clock,
  Cookie,
  Copy,
  Download,
  FileCode,
  FileText,
  KeyRound,
  Loader2,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CodeViewer } from "@/components/code-viewer";
import {
  browserAddValidationCustom,
  browserCheckValidation,
  browserClearValidation,
  browserListValidationItems,
  validatorExportUrl,
} from "@/lib/api";
import type { ValidationItem, ValidationSummary } from "@/lib/api";
import { cn, copyToClipboard } from "@/lib/utils";

export function ValidatorView() {
  const [mainTab, setMainTab] = useState<"cookies" | "passwords">("cookies");
  const selectedService = "chatgpt";
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [items, setItems] = useState<ValidationItem[]>([]);
  const [summary, setSummary] = useState<ValidationSummary>({
    total: 0,
    notChecked: 0,
    valid: 0,
    notValid: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isChecking, setIsChecking] = useState(false);
  const [selectedItemForInspect, setSelectedItemForInspect] =
    useState<ValidationItem | null>(null);

  // Custom modal state
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false);
  const [customDomain, setCustomDomain] = useState("openai.com");
  const [customCookieText, setCustomCookieText] = useState("");
  const [isSubmittingCustom, setIsSubmittingCustom] = useState(false);

  const loadItems = useCallback(
    async (showLoading = true) => {
      if (showLoading) setIsLoading(true);
      const res = await browserListValidationItems(
        selectedService,
        statusFilter,
        200,
        0,
      );
      setIsLoading(false);
      if (res.ok) {
        setItems(res.data.items);
        setSummary(res.data.summary);
      } else {
        toast.error(res.error?.message ?? "Failed to load validator items.");
      }
    },
    [selectedService, statusFilter],
  );

  useEffect(() => {
    void loadItems(true);
  }, [loadItems]);

  const handleRunValidation = async () => {
    if (summary.notChecked === 0 && summary.total === 0) {
      toast.info("No items in queue to validate. Add cookies first.");
      return;
    }
    setIsChecking(true);
    const res = await browserCheckValidation(selectedService);
    setIsChecking(false);
    if (res.ok) {
      toast.success(
        `Checked ${res.data.checkedCount} items for OpenAI / ChatGPT.`,
      );
      void loadItems(false);
    } else {
      toast.error(res.error?.message ?? "Validation check failed.");
    }
  };

  const handleClear = async () => {
    const res = await browserClearValidation(selectedService);
    if (res.ok) {
      toast.info("Cleared validator queue.");
      void loadItems(false);
    } else {
      toast.error(res.error?.message ?? "Failed to clear validator.");
    }
  };

  const handleAddCustom = async () => {
    if (!customCookieText.trim()) {
      toast.error("Please paste your cookies before submitting.");
      return;
    }
    setIsSubmittingCustom(true);
    const res = await browserAddValidationCustom({
      domain: customDomain.trim() || "openai.com",
      service: selectedService,
      cookieText: customCookieText,
    });
    setIsSubmittingCustom(false);
    if (res.ok) {
      toast.success("Custom cookies added — verifying instantly in background!");
      setCustomCookieText("");
      setIsCustomModalOpen(false);
      // Wait a short moment for background auto-validation to update state
      setTimeout(() => void loadItems(false), 500);
    } else {
      toast.error(res.error?.message ?? "Failed to add custom cookies.");
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* Top Primary Mode Switcher: Cookie Validator vs Password Validator (WIP) */}
      <div className="flex items-center gap-2 p-1 rounded-full border border-white/[0.08] bg-[#0c0d0e]/80 backdrop-blur-2xl w-fit shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.12)]">
        <button
          type="button"
          onClick={() => setMainTab("cookies")}
          className={cn(
            "flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 cursor-pointer",
            mainTab === "cookies"
              ? "bg-white/[0.14] text-[#f7f8f8] shadow-[inset_0_1px_1px_rgba(255,255,255,0.25)] border border-white/20"
              : "text-[#8a8f98] hover:text-[#d0d6e0] hover:bg-white/[0.04]",
          )}
        >
          <Cookie className="size-3.5 text-emerald-400" />
          <span>Cookie Validator</span>
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </button>

        <button
          type="button"
          onClick={() => setMainTab("passwords")}
          className={cn(
            "flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 cursor-pointer",
            mainTab === "passwords"
              ? "bg-white/[0.14] text-[#f7f8f8] shadow-[inset_0_1px_1px_rgba(255,255,255,0.25)] border border-white/20"
              : "text-[#8a8f98] hover:text-[#d0d6e0] hover:bg-white/[0.04]",
          )}
        >
          <Lock className="size-3.5 text-amber-400" />
          <span>Password Validator</span>
          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-normal">
            Work in progress
          </span>
        </button>
      </div>

      {mainTab === "passwords" ? (
        /* Password Validator Work In Progress View */
        <section className="flex flex-col items-center justify-center gap-4 rounded-[12px] border border-amber-500/20 bg-[#0c0d0e]/80 p-12 text-center backdrop-blur-2xl shadow-[0_16px_50px_rgba(0,0,0,0.5),inset_0_1px_1.5px_rgba(255,255,255,0.12)]">
          <div className="flex size-14 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 shadow-[0_0_20px_rgba(245,158,11,0.2)]">
            <KeyRound className="size-7" />
          </div>
          <div className="flex flex-col gap-1.5 max-w-md">
            <div className="flex items-center justify-center gap-2">
              <h2 className="text-base font-semibold text-white">
                Password &amp; Credential Validator
              </h2>
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-400 text-[10px]"
              >
                Work in progress
              </Badge>
            </div>
            <p className="text-xs text-[#8a8f98] leading-relaxed">
              Automated stealer password lists, credentials.txt auditing, and hash verification pipelines are under active development.
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-[#62666d]">
            <span>Target: stealer password vaults</span>
            <span>·</span>
            <span>Status: Engine in development</span>
          </div>
        </section>
      ) : (
        /* Cookie Validator Active View */
        <>
          {/* Top Header & Service Indicator */}
          <section className="rounded-[10px] border border-white/[0.08] bg-[#0c0d0e]/80 p-4 sm:p-5 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_1.5px_rgba(255,255,255,0.12)]">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h1 className="text-base font-semibold tracking-tight text-[#f7f8f8]">
                  OpenAI Validator
                </h1>
              </div>

              {/* Metrics summary cards */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="flex flex-col gap-0.5 rounded-[8px] border border-sky-500/20 bg-sky-500/[0.02] px-3.5 py-2.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[#8a8f98]">
                    Total
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-[#f7f8f8]">
                    {summary.total}
                  </span>
                </div>

                <div className="flex flex-col gap-0.5 rounded-[8px] border border-slate-500/20 bg-slate-500/[0.02] px-3.5 py-2.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[#8a8f98]">
                    Not Checked
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-amber-400/90">
                    {summary.notChecked}
                  </span>
                </div>

                <div className="flex flex-col gap-0.5 rounded-[8px] border border-emerald-500/25 bg-emerald-500/[0.03] px-3.5 py-2.5 shadow-[0_0_15px_rgba(16,185,129,0.03)]">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-emerald-400/80">
                    Valid
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-emerald-400">
                    {summary.valid}
                  </span>
                </div>

                <div className="flex flex-col gap-0.5 rounded-[8px] border border-rose-500/25 bg-rose-500/[0.03] px-3.5 py-2.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-rose-400/80">
                    Not Valid
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-rose-400">
                    {summary.notValid}
                  </span>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-white/[0.06] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={handleRunValidation}
                    disabled={isChecking || isLoading}
                    className="gap-1.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs shadow-[0_0_15px_rgba(16,185,129,0.3)] transition-all cursor-pointer"
                  >
                    {isChecking ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5 fill-black" />
                    )}
                    Check All
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsCustomModalOpen(true)}
                    className="gap-1.5 rounded-full text-xs border-white/[0.12] bg-white/[0.03] hover:bg-white/[0.08]"
                  >
                    <Plus className="size-3.5" />
                    Add Custom
                  </Button>

                  {summary.valid > 0 ? (
                    <a
                      href={validatorExportUrl(selectedService)}
                      download
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                    >
                      <Download className="size-3.5" />
                      Export Valid ({summary.valid})
                    </a>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  {/* Filter tabs */}
                  <div className="flex items-center gap-1 text-[11px] rounded-full border border-white/[0.08] bg-black/40 p-0.5">
                    {[
                      { id: "", label: "All" },
                      { id: "valid", label: "Valid" },
                      { id: "not_valid", label: "Not Valid" },
                      { id: "not_checked", label: "Not Checked" },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setStatusFilter(f.id)}
                        className={cn(
                          "px-2.5 py-0.5 rounded-full transition-colors cursor-pointer",
                          statusFilter === f.id
                            ? "bg-white/[0.12] text-[#f7f8f8] font-medium"
                            : "text-[#8a8f98] hover:text-[#d0d6e0]",
                        )}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {summary.total > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={handleClear}
                      className="text-xs text-[#8a8f98] hover:text-rose-400"
                    >
                      <Trash2 className="size-3 mr-1" />
                      Clear
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          {/* Main Validation Items Table */}
          <section className="rounded-[10px] border border-white/[0.08] bg-[#0c0d0e]/80 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden">
            {isLoading ? (
              <div className="flex h-64 items-center justify-center gap-2 text-xs text-[#8a8f98]">
                <Loader2 className="size-4 animate-spin text-emerald-400" />
                <span>Loading validator queue…</span>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2.5 text-center px-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-white/[0.03] border border-white/[0.08] text-[#8a8f98]">
                  <FileCode className="size-5" />
                </span>
                <p className="text-sm font-medium text-[#f7f8f8]">
                  No cookies in queue
                </p>
                <p className="text-xs text-[#8a8f98] max-w-sm">
                  Send from Cookies tab or click Add Custom.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-white/[0.02] border-b border-white/[0.06]">
                    <TableRow className="border-none hover:bg-transparent">
                      <TableHead className="w-28 text-xs text-[#8a8f98]">
                        Status
                      </TableHead>
                      <TableHead className="text-xs text-[#8a8f98]">
                        Domain
                      </TableHead>
                      <TableHead className="text-xs text-[#8a8f98]">
                        Source
                      </TableHead>
                      <TableHead className="text-xs text-[#8a8f98]">
                        Cookies
                      </TableHead>
                      <TableHead className="text-xs text-[#8a8f98]">
                        Result
                      </TableHead>
                      <TableHead className="text-right text-xs text-[#8a8f98]">
                        Inspect
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((it) => (
                      <TableRow
                        key={it.id}
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                      >
                        <TableCell className="font-mono text-xs">
                          {it.status === "valid" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                              <CheckCircle2 className="size-3" />
                              Valid
                            </span>
                          ) : it.status === "not_valid" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border border-rose-500/30 bg-rose-500/10 text-rose-400">
                              <XCircle className="size-3" />
                              Not Valid
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border border-white/[0.12] bg-white/[0.04] text-[#8a8f98]">
                              <Clock className="size-3 text-amber-400" />
                              Not Checked
                            </span>
                          )}
                        </TableCell>

                        <TableCell className="font-mono text-xs font-semibold text-[#f7f8f8]">
                          {it.domain}
                        </TableCell>

                        <TableCell className="text-xs text-[#d0d6e0] max-w-xs truncate">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-[#f7f8f8] truncate">
                              {it.archiveFilename || "Custom Paste"}
                            </span>
                            <span className="font-mono text-[10px] text-[#62666d] truncate">
                              {it.entryPath || "Manual Input"}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="font-mono text-xs text-[#8a8f98]">
                          {it.cookieCount}
                        </TableCell>

                        <TableCell className="text-xs text-[#8a8f98] max-w-xs truncate font-mono text-[11px]">
                          {it.errorMessage ? (
                            <span className="text-rose-400/90">{it.errorMessage}</span>
                          ) : it.status === "valid" ? (
                            <span className="text-emerald-400/90">auth.openai.com session active</span>
                          ) : (
                            <span className="text-[#62666d]">Pending check</span>
                          )}
                        </TableCell>

                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setSelectedItemForInspect(it)}
                            className="rounded-full text-xs text-[#8a8f98] hover:text-[#f7f8f8] hover:bg-white/[0.06]"
                          >
                            Inspect
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {/* Inspect Cookie Modal */}
          <Dialog
            open={selectedItemForInspect !== null}
            onOpenChange={(open) => !open && setSelectedItemForInspect(null)}
          >
            <DialogContent className="rounded-[10px] border border-white/[0.12] bg-[#0c0d0e]/95 backdrop-blur-2xl sm:max-w-2xl text-[#f7f8f8] shadow-[0_16px_50px_rgba(0,0,0,0.6)]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="size-4 text-emerald-400" />
                  <span>Cookie Log Inspection</span>
                  {selectedItemForInspect ? (
                    <Badge variant="outline" className="font-mono text-[10px] uppercase">
                      {selectedItemForInspect.domain}
                    </Badge>
                  ) : null}
                </DialogTitle>
                <DialogDescription className="text-xs text-[#8a8f98]">
                  {selectedItemForInspect?.entryPath || "Custom cookie payload"}
                </DialogDescription>
              </DialogHeader>

              {selectedItemForInspect ? (
                <div className="flex flex-col gap-3">
                  <div className="max-h-[350px] overflow-auto rounded-[6px] border border-white/[0.08] bg-black/60 p-3 font-mono text-xs">
                    <CodeViewer
                      content={selectedItemForInspect.cookieText}
                      filename="cookies.txt"
                      wrapLines={true}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-[#8a8f98]">
                      {selectedItemForInspect.cookieCount} cookies in this log
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        copyToClipboard(selectedItemForInspect.cookieText);
                        toast.success("Cookies copied to clipboard.");
                      }}
                      className="gap-1.5 rounded-full text-xs border-white/[0.12]"
                    >
                      <Copy className="size-3.5" />
                      Copy Cookies
                    </Button>
                  </div>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>

          {/* Custom Cookies Dialog */}
          <Dialog open={isCustomModalOpen} onOpenChange={setIsCustomModalOpen}>
            <DialogContent className="rounded-[10px] border border-white/[0.12] bg-[#0c0d0e]/95 backdrop-blur-2xl sm:max-w-lg text-[#f7f8f8] shadow-[0_16px_50px_rgba(0,0,0,0.6)]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Plus className="size-4 text-emerald-400" />
                  <span>Add Custom Cookies to Checker</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-[#8a8f98]">
                  Paste raw Netscape or JSON cookies. They will be verified for auth.openai.com automatically upon insertion.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3 py-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-[#d0d6e0]">
                    Target Domain
                  </label>
                  <Input
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="openai.com"
                    className="font-mono text-xs rounded-[6px] bg-black/40 border-white/[0.12]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-[#d0d6e0]">
                    Raw Cookie Text (Netscape / JSON)
                  </label>
                  <textarea
                    value={customCookieText}
                    onChange={(e) => setCustomCookieText(e.target.value)}
                    placeholder={`# Netscape HTTP Cookie File\n.auth.openai.com\tTRUE\t/\tTRUE\t1790000000\t__Secure-next-auth.session-token\tsome_token_here...`}
                    rows={8}
                    className="w-full rounded-[6px] border border-white/[0.12] bg-black/50 p-2.5 font-mono text-xs text-[#f7f8f8] placeholder:text-[#62666d] focus:border-emerald-500/50 focus:outline-none"
                  />
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsCustomModalOpen(false)}
                  className="text-xs text-[#8a8f98]"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleAddCustom}
                  disabled={isSubmittingCustom}
                  className="gap-1.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs cursor-pointer"
                >
                  {isSubmittingCustom ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  Queue &amp; Verify
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
