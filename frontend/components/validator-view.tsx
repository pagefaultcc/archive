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
import { MotionSurface } from "@/components/motion-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { copyToClipboard } from "@/lib/utils";

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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl
          label="Validator mode"
          value={mainTab}
          onValueChange={(value) => setMainTab(value as "cookies" | "passwords")}
          options={[
            { value: "cookies", label: "Cookie Validator", icon: <Cookie /> },
            { value: "passwords", label: "Password Validator", icon: <Lock /> },
          ]}
          className="w-full sm:w-fit"
        />
        <p className="text-[11px] text-[#8a8f98]">
          Password Validator: <span>Work in progress</span>
        </p>
      </div>

      {mainTab === "passwords" ? (
        /* Password Validator Work In Progress View */
        <section className="spinup-card flex flex-col items-center justify-center gap-4 px-4 py-10 text-center sm:p-12">
          <div className="flex size-14 items-center justify-center rounded-full border border-white/[0.08] bg-[#0e0f11] text-neutral-400">
            <KeyRound className="size-7" />
          </div>
          <div className="flex max-w-md min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <h2 className="text-base font-semibold text-white">
                Password &amp; Credential Validator
              </h2>
              <span className="spinup-pill text-[10px]">
                Work in progress
              </span>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">
              Automated stealer password lists, credentials.txt auditing, and hash verification pipelines are under active development.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-mono text-[11px] text-neutral-500">
            <span>Target: stealer password vaults</span>
            <span aria-hidden="true" className="hidden sm:inline">·</span>
            <span>Status: Engine in development</span>
          </div>
        </section>
      ) : (
        /* Cookie Validator Active View */
        <>
          {/* SpinupMail 4-Card Metric Grid */}
          <MotionSurface busy={isChecking}>
            <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="spinup-card flex flex-col justify-between p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-400">
                    Total
                  </span>
                  <span className="spinup-pill">Queue</span>
                </div>
                <span className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-white">
                  {summary.total}
                </span>
              </div>

              <div className="spinup-card flex flex-col justify-between p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-400">
                    Not Checked
                  </span>
                  <span className="spinup-pill">Pending</span>
                </div>
                <span className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-white">
                  {summary.notChecked}
                </span>
              </div>

              <div className="spinup-card flex flex-col justify-between p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-400">
                    Valid
                  </span>
                  <span className="spinup-pill text-[#00ba7c]">OpenAI</span>
                </div>
                <span className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-[#00ba7c]">
                  {summary.valid}
                </span>
              </div>

              <div className="spinup-card flex flex-col justify-between p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-400">
                    Not Valid
                  </span>
                  <span className="spinup-pill text-[#f91880]">Expired</span>
                </div>
                <span className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-[#f91880]">
                  {summary.notValid}
                </span>
              </div>
            </section>
          </MotionSurface>

          {/* Main Validation Items Table */}
          <section className="spinup-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-white/[0.07] px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-sm font-semibold tracking-tight text-white mr-2">
                  OpenAI Validator
                </h1>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleRunValidation}
                  disabled={isChecking || isLoading}
                  className="motion-sheen h-8 gap-1.5 rounded-lg text-xs cursor-pointer transition-none hover:scale-100 active:scale-100 [&_svg]:size-3.5"
                >
                  {isChecking ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  Check All
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsCustomModalOpen(true)}
                  className="h-8 gap-1.5 rounded-lg text-xs border-white/[0.08] bg-[#0e0f11] text-neutral-200 hover:bg-white/[0.06] transition-none hover:scale-100 active:scale-100 [&_svg]:size-3.5"
                >
                  <Plus className="size-3.5" />
                  Add Custom
                </Button>

                {summary.valid > 0 ? (
                  <a
                    href={validatorExportUrl(selectedService)}
                    download
                    className="inline-flex h-8 items-center justify-center gap-1.5 px-3 rounded-lg text-xs font-medium border border-[rgba(0,186,124,0.3)] bg-[rgba(0,186,124,0.1)] text-[#00ba7c] hover:bg-[rgba(0,186,124,0.15)] transition-none [&_svg]:shrink-0"
                  >
                    <Download className="size-3.5" />
                    Export Valid ({summary.valid})
                  </a>
                ) : null}
              </div>

              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <SegmentedControl
                  label="Validation status"
                  value={statusFilter}
                  onValueChange={setStatusFilter}
                  options={[
                    { value: "", label: "All" },
                    { value: "valid", label: "Valid" },
                    { value: "not_valid", label: "Not Valid" },
                    { value: "not_checked", label: "Not Checked" },
                  ]}
                  size="sm"
                  className="auto-cols-auto"
                />

                {summary.total > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={handleClear}
                    className="gap-1 text-xs text-neutral-400 hover:text-[#f91880] transition-none hover:scale-100 active:scale-100"
                  >
                    <Trash2 className="size-3" />
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>

            {isLoading ? (
              <div className="flex h-64 items-center justify-center gap-2 text-xs text-neutral-400">
                <Loader2 className="size-4 animate-spin text-neutral-400" />
                <span>Loading validator queue…</span>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2.5 text-center px-4">
                <span className="flex size-10 items-center justify-center rounded-full bg-[#0e0f11] border border-white/[0.08] text-neutral-400">
                  <FileCode className="size-5" />
                </span>
                <p className="text-sm font-medium text-white">
                  No cookies in queue
                </p>
                <p className="text-xs text-neutral-500 max-w-sm">
                  Send from Cookies tab or click Add Custom.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-[#0e0f11]/60 border-b border-white/[0.06]">
                    <TableRow className="border-none hover:bg-transparent">
                      <TableHead className="py-3 px-4 w-28 text-xs font-medium text-neutral-400">
                        Status
                      </TableHead>
                      <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">
                        Domain
                      </TableHead>
                      <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">
                        Source
                      </TableHead>
                      <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">
                        Cookies
                      </TableHead>
                      <TableHead className="py-3 px-4 text-xs font-medium text-neutral-400">
                        Result
                      </TableHead>
                      <TableHead className="py-3 px-4 text-right text-xs font-medium text-neutral-400">
                        Inspect
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((it) => (
                      <TableRow
                        key={it.id}
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-none"
                      >
                        <TableCell className="py-3.5 px-4 font-mono text-xs">
                          {it.status === "valid" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border border-[rgba(0,186,124,0.3)] bg-[rgba(0,186,124,0.1)] text-[#00ba7c]">
                              <CheckCircle2 className="size-3" />
                              Valid
                            </span>
                          ) : it.status === "not_valid" ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border border-[rgba(249,24,128,0.3)] bg-[rgba(249,24,128,0.1)] text-[#f91880]">
                              <XCircle className="size-3" />
                              Not Valid
                            </span>
                          ) : (
                            <span className="spinup-pill inline-flex items-center gap-1.5">
                              <Clock className="size-3 text-neutral-400" />
                              Not Checked
                            </span>
                          )}
                        </TableCell>

                        <TableCell className="py-3.5 px-4 font-mono text-xs font-semibold text-white">
                          {it.domain}
                        </TableCell>

                        <TableCell className="py-3.5 px-4 text-xs text-neutral-300 max-w-xs truncate">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-white truncate">
                              {it.archiveFilename || "Custom Paste"}
                            </span>
                            <span className="font-mono text-[10px] text-neutral-500 truncate">
                              {it.entryPath || "Manual Input"}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="py-3.5 px-4 font-mono text-xs text-neutral-400">
                          {it.cookieCount}
                        </TableCell>

                        <TableCell className="py-3.5 px-4 text-xs text-neutral-400 max-w-xs truncate font-mono text-[11px]">
                          {it.errorMessage ? (
                            <span className="text-[#f91880]">{it.errorMessage}</span>
                          ) : it.status === "valid" ? (
                            <span className="text-[#00ba7c]">auth.openai.com session active</span>
                          ) : (
                            <span className="text-neutral-500">Pending check</span>
                          )}
                        </TableCell>

                        <TableCell className="py-3.5 px-4 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setSelectedItemForInspect(it)}
                            className="rounded-lg text-xs text-neutral-400 hover:text-white hover:bg-white/[0.06]"
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
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[8px] border border-white/[0.12] bg-[#0f1011] p-4 text-[#f7f8f8] shadow-lg sm:max-w-2xl sm:p-6">
              <DialogHeader className="min-w-0 pr-6 text-left">
                <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm font-semibold leading-5">
                  <FileText className="size-4 shrink-0 text-[#8a8f98]" />
                  <span>Cookie Log Inspection</span>
                  {selectedItemForInspect ? (
                    <Badge variant="outline" className="max-w-full whitespace-normal break-all font-mono text-[10px] uppercase">
                      {selectedItemForInspect.domain}
                    </Badge>
                  ) : null}
                </DialogTitle>
                <DialogDescription className="min-w-0 break-all text-xs text-[#8a8f98]">
                  {selectedItemForInspect?.entryPath || "Custom cookie payload"}
                </DialogDescription>
              </DialogHeader>

              {selectedItemForInspect ? (
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="max-h-[350px] min-w-0 overflow-auto rounded-[6px] border border-white/[0.08] bg-black/60 p-3 font-mono text-xs">
                    <CodeViewer
                      content={selectedItemForInspect.cookieText}
                      filename="cookies.txt"
                      wrapLines={true}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
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
                      className="h-8 gap-1.5 rounded-full text-xs border-white/[0.12] transition-none hover:scale-100 active:scale-100"
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
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[8px] border border-white/[0.12] bg-[#0f1011] p-4 text-[#f7f8f8] shadow-lg sm:max-w-lg sm:p-6">
              <DialogHeader className="min-w-0 pr-6 text-left">
                <DialogTitle className="flex items-start gap-2 text-sm font-semibold leading-5">
                  <Plus className="mt-0.5 size-4 shrink-0 text-[#8a8f98]" />
                  <span className="min-w-0">Add Custom Cookies to Checker</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-[#8a8f98]">
                  Paste raw Netscape or JSON cookies. They will be verified for auth.openai.com automatically upon insertion.
                </DialogDescription>
              </DialogHeader>

              <div className="flex min-w-0 flex-col gap-3 py-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor="validator-custom-domain" className="text-xs font-medium text-[#d0d6e0]">
                    Target Domain
                  </label>
                  <Input
                    id="validator-custom-domain"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="openai.com"
                    className="min-w-0 font-mono text-xs rounded-[6px] bg-black/40 border-white/[0.12]"
                  />
                </div>

                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor="validator-custom-cookie-text" className="text-xs font-medium text-[#d0d6e0]">
                    Raw Cookie Text (Netscape / JSON)
                  </label>
                  <textarea
                    id="validator-custom-cookie-text"
                    value={customCookieText}
                    onChange={(e) => setCustomCookieText(e.target.value)}
                    placeholder={`# Netscape HTTP Cookie File\n.auth.openai.com\tTRUE\t/\tTRUE\t1790000000\t__Secure-next-auth.session-token\tsome_token_here...`}
                    rows={8}
                    className="min-w-0 w-full rounded-[6px] border border-white/[0.12] bg-black/50 p-2.5 font-mono text-xs text-[#f7f8f8] placeholder:text-[#62666d] focus:border-[rgba(255,255,255,0.2)] focus:outline-none"
                  />
                </div>
              </div>

              <DialogFooter className="flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsCustomModalOpen(false)}
                  className="h-8 text-xs text-[#8a8f98] transition-none hover:scale-100 active:scale-100"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAddCustom}
                  disabled={isSubmittingCustom}
                  className="h-8 gap-1.5 rounded-full text-xs cursor-pointer transition-none hover:scale-100 active:scale-100"
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
