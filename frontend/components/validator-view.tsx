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
  Trash2,
  XCircle,
} from "lucide-react";
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
      toast.success(
        "Custom cookies added — verifying automatically in background!",
      );
      setCustomCookieText("");
      setIsCustomModalOpen(false);
      setTimeout(() => void loadItems(false), 500);
    } else {
      toast.error(res.error?.message ?? "Failed to add custom cookies.");
    }
  };

  return (
    <div className="flex min-w-0 w-full flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label="Validator mode"
          value={mainTab}
          onValueChange={(value) =>
            setMainTab(value as "cookies" | "passwords")
          }
          options={[
            { value: "cookies", label: "Cookie Validator", icon: <Cookie /> },
            { value: "passwords", label: "Password Validator", icon: <Lock /> },
          ]}
          className="w-full sm:w-fit"
        />
        <span className="font-mono text-[11px] text-[#6b707b]">
          Target: auth.openai.com · Instant background verification
        </span>
      </div>

      {mainTab === "passwords" ? (
        <section className="obsidian-panel flex flex-col items-center justify-center gap-3 px-4 py-14 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg border border-white/[0.08] bg-[#101216] text-[#8b909a]">
            <KeyRound className="size-5" />
          </div>
          <div className="flex max-w-md flex-col gap-1">
            <div className="flex items-center justify-center gap-2">
              <h2 className="text-sm font-semibold text-[#f3f4f6]">
                Password &amp; Credential Validator
              </h2>
              <span className="obsidian-pill text-[10px]">Work in progress</span>
            </div>
            <p className="text-xs text-[#6b707b]">
              Automated credential verification pipelines are under development.
            </p>
          </div>
        </section>
      ) : (
        <>
          {/* Architectural 4-Column Telemetry Ribbon */}
          <section className="obsidian-panel grid grid-cols-2 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-4 sm:divide-x sm:divide-y-0">
            <div className="flex flex-col justify-between gap-1.5 p-4">
              <div className="flex items-center justify-between text-xs text-[#8b909a]">
                <span>Total</span>
                <span className="obsidian-pill text-[10px]">Queue</span>
              </div>
              <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
                {summary.total}
              </span>
            </div>

            <div className="flex flex-col justify-between gap-1.5 p-4">
              <div className="flex items-center justify-between text-xs text-[#8b909a]">
                <span>Not Checked</span>
                <span className="obsidian-pill text-[10px]">Pending</span>
              </div>
              <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
                {summary.notChecked}
              </span>
            </div>

            <div className="flex flex-col justify-between gap-1.5 p-4">
              <div className="flex items-center justify-between text-xs text-[#8b909a]">
                <span>Valid</span>
                <span className="obsidian-pill text-[10px] text-[#10b981]">
                  Active
                </span>
              </div>
              <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#10b981]">
                {summary.valid}
              </span>
            </div>

            <div className="flex flex-col justify-between gap-1.5 p-4">
              <div className="flex items-center justify-between text-xs text-[#8b909a]">
                <span>Not Valid</span>
                <span className="obsidian-pill text-[10px] text-[#f43f5e]">
                  Expired
                </span>
              </div>
              <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[#f43f5e]">
                {summary.notValid}
              </span>
            </div>
          </section>

          {/* Validation Queue Ledger */}
          <section className="obsidian-panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-white/[0.06] px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="mr-1 text-sm font-semibold text-[#f3f4f6]">
                  OpenAI Session Queue
                </h1>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleRunValidation()}
                  disabled={isChecking || isLoading}
                  className="h-8 gap-1.5 rounded-lg bg-[#f3f4f6] px-3 text-xs font-medium text-[#050506] hover:bg-white"
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
                  className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] px-3 text-xs text-[#e5e7eb] hover:bg-white/[0.05]"
                >
                  <Plus className="size-3.5" />
                  Add Custom
                </Button>

                {summary.valid > 0 ? (
                  <a
                    href={validatorExportUrl(selectedService)}
                    download
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-[#10b981] hover:bg-emerald-500/15"
                  >
                    <Download className="size-3.5" />
                    Export Valid ({summary.valid})
                  </a>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
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
                    onClick={() => void handleClear()}
                    className="h-8 gap-1 text-xs text-[#8b909a] hover:text-[#f43f5e]"
                  >
                    <Trash2 className="size-3" />
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>

            {isLoading ? (
              <div className="flex h-56 items-center justify-center gap-2 text-xs text-[#8b909a]">
                <Loader2 className="size-4 animate-spin" />
                <span>Loading validator queue…</span>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center gap-2 px-4 text-center">
                <FileCode className="size-5 text-[#5c606a]" />
                <p className="text-xs font-medium text-[#f3f4f6]">
                  No cookies in queue
                </p>
                <p className="max-w-sm text-[11px] text-[#6b707b]">
                  Send logs from the Cookies Explorer or click Add Custom to verify tokens.
                </p>
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.06] bg-[#101216]/70 text-[11px] font-medium text-[#8b909a]">
                      <th className="w-32 py-2.5 px-4 font-medium">Status</th>
                      <th className="py-2.5 px-4 font-medium">Domain</th>
                      <th className="py-2.5 px-4 font-medium">Source</th>
                      <th className="py-2.5 px-4 font-medium">Cookies</th>
                      <th className="py-2.5 px-4 font-medium">Verification</th>
                      <th className="py-2.5 px-4 text-right font-medium">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {items.map((it) => (
                      <tr
                        key={it.id}
                        className="transition-colors hover:bg-white/[0.02]"
                      >
                        <td className="py-3 px-4 font-mono text-xs whitespace-nowrap">
                          {it.status === "valid" ? (
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-[#10b981]">
                              <CheckCircle2 className="size-3" />
                              Valid
                            </span>
                          ) : it.status === "not_valid" ? (
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-[#f43f5e]">
                              <XCircle className="size-3" />
                              Not Valid
                            </span>
                          ) : (
                            <span className="obsidian-pill gap-1.5">
                              <Clock className="size-3 text-[#8b909a]" />
                              Not Checked
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 font-mono text-xs font-semibold text-[#f3f4f6]">
                          {it.domain}
                        </td>

                        <td className="max-w-xs truncate py-3 px-4 text-xs">
                          <div className="flex flex-col gap-0.5">
                            <span className="truncate font-medium text-[#e5e7eb]">
                              {it.archiveFilename || "Custom Paste"}
                            </span>
                            <span className="truncate font-mono text-[10.5px] text-[#6b707b]">
                              {it.entryPath || "Manual Input"}
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-4 font-mono text-xs text-[#8b909a]">
                          {it.cookieCount}
                        </td>

                        <td className="max-w-xs truncate py-3 px-4 font-mono text-[11px]">
                          {it.errorMessage ? (
                            <span className="text-[#f43f5e]">
                              {it.errorMessage}
                            </span>
                          ) : it.status === "valid" ? (
                            <span className="text-[#10b981]">
                              auth.openai.com session active
                            </span>
                          ) : (
                            <span className="text-[#6b707b]">Pending check</span>
                          )}
                        </td>

                        <td className="py-3 px-4 text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => setSelectedItemForInspect(it)}
                            className="h-7 rounded-md border-white/[0.08] bg-[#101216] px-2.5 text-xs text-[#e5e7eb] hover:bg-white/[0.06]"
                          >
                            Inspect
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Inspect Cookie Modal */}
          <Dialog
            open={selectedItemForInspect !== null}
            onOpenChange={(open) => !open && setSelectedItemForInspect(null)}
          >
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-white/[0.08] bg-[#0b0c0e] p-5 text-[#f3f4f6] sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="size-4 text-[#8b909a]" />
                  <span>Cookie Payload Inspection</span>
                  {selectedItemForInspect ? (
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] uppercase"
                    >
                      {selectedItemForInspect.domain}
                    </Badge>
                  ) : null}
                </DialogTitle>
                <DialogDescription className="break-all font-mono text-xs text-[#8b909a]">
                  {selectedItemForInspect?.entryPath || "Custom cookie payload"}
                </DialogDescription>
              </DialogHeader>

              {selectedItemForInspect ? (
                <div className="flex flex-col gap-3">
                  <div className="max-h-[360px] overflow-auto">
                    <CodeViewer
                      content={selectedItemForInspect.cookieText}
                      filename="cookies.txt"
                      wrapLines={true}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="font-mono text-xs text-[#8b909a]">
                      {selectedItemForInspect.cookieCount} cookies
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void copyToClipboard(selectedItemForInspect.cookieText);
                        toast.success("Cookies copied to clipboard.");
                      }}
                      className="h-8 gap-1.5 rounded-lg border-white/[0.08] bg-[#101216] text-xs"
                    >
                      <Copy className="size-3.5" />
                      Copy Cookies
                    </Button>
                  </div>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>

          {/* Add Custom Cookies Dialog */}
          <Dialog open={isCustomModalOpen} onOpenChange={setIsCustomModalOpen}>
            <DialogContent className="rounded-xl border border-white/[0.08] bg-[#0b0c0e] p-5 text-[#f3f4f6] sm:max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Plus className="size-4 text-[#8b909a]" />
                  <span>Add Custom Cookies</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-[#8b909a]">
                  Paste raw Netscape or JSON cookies. Verification runs automatically in the background.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3 py-1">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="validator-custom-domain"
                    className="text-xs font-medium text-[#c8ccd4]"
                  >
                    Target Domain
                  </label>
                  <Input
                    id="validator-custom-domain"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="openai.com"
                    className="obsidian-input h-8 font-mono text-xs"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="validator-custom-cookie-text"
                    className="text-xs font-medium text-[#c8ccd4]"
                  >
                    Raw Cookie Payload (Netscape / JSON)
                  </label>
                  <textarea
                    id="validator-custom-cookie-text"
                    value={customCookieText}
                    onChange={(e) => setCustomCookieText(e.target.value)}
                    placeholder={`# Netscape HTTP Cookie File\n.auth.openai.com\tTRUE\t/\tTRUE\t1790000000\t__Secure-next-auth.session-token\tsome_token_here...`}
                    rows={8}
                    className="obsidian-input w-full p-2.5 font-mono text-xs"
                  />
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsCustomModalOpen(false)}
                  className="h-8 text-xs text-[#8b909a]"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleAddCustom()}
                  disabled={isSubmittingCustom}
                  className="h-8 gap-1.5 bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
                >
                  {isSubmittingCustom ? (
                    <Loader2 className="size-3.5 animate-spin" />
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
