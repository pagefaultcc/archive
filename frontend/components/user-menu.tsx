"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronsUpDown,
  KeyRound,
  Loader2,
  LogOut,
  Settings,
  ShieldCheck,
  User,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { browserChangePassword, browserLogout } from "@/lib/api";
import { toast } from "sonner";

export function UserMenu({
  username,
  roleLabel,
  compact = false,
}: {
  username: string;
  roleLabel?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  async function logout() {
    setBusy(true);
    const result = await browserLogout();
    if (result.ok || result.status === 401) {
      startTransition(() => router.replace("/login"));
    } else {
      setBusy(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword) {
      toast.error("Please enter your current password.");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters long.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match.");
      return;
    }

    setIsChangingPassword(true);
    const res = await browserChangePassword({
      currentPassword,
      newPassword,
    });
    setIsChangingPassword(false);

    if (res.ok) {
      toast.success("Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setIsSettingsOpen(false);
    } else {
      toast.error(res.error?.message ?? "Failed to change password.");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <button
              type="button"
              disabled={pending || busy}
              aria-label={`User account for ${username}`}
              className="flex size-7 items-center justify-center rounded-md border border-white/[0.08] bg-[#111318] text-[11px] font-semibold text-[#f3f4f6] transition-colors hover:border-white/[0.16] hover:bg-white/[0.06] disabled:opacity-50 cursor-pointer"
            >
              <span>{username.slice(0, 2).toUpperCase()}</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || busy}
              aria-label={`User account for ${username}`}
              className="flex w-full items-center gap-2.5 rounded-lg border border-white/[0.06] bg-[#0c0d10] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-[#111318] disabled:opacity-50 cursor-pointer"
            >
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-[#14171d] text-[11px] font-semibold text-[#f3f4f6]"
              >
                {username.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-xs font-medium text-[#f3f4f6]">
                  {username}
                </p>
                <p className="truncate font-mono text-[10px] text-[#6b707b]">
                  {roleLabel ?? "user"}
                </p>
              </div>
              <ChevronsUpDown
                aria-hidden
                className="size-3.5 shrink-0 text-[#5c606a]"
              />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={compact ? "bottom" : "top"}
          align={compact ? "end" : "start"}
          sideOffset={8}
          className="w-56 rounded-lg border border-white/[0.08] bg-[#0b0c0e] p-1 text-[#f3f4f6] shadow-[0_16px_40px_rgba(0,0,0,0.7)]"
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2.5 px-2.5 py-2 text-left">
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-[#14171d] text-[11px] font-semibold text-white"
              >
                {username.slice(0, 2).toUpperCase()}
              </span>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-xs font-semibold text-[#f3f4f6]">
                  {username}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-[#8b909a]">
                  <ShieldCheck className="size-3 shrink-0 text-[#10b981]" aria-hidden />
                  <span className="truncate font-mono text-[10px]">
                    {roleLabel ?? "user"}
                  </span>
                </span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-white/[0.06]" />

          <DropdownMenuItem
            onSelect={() => setIsSettingsOpen(true)}
            className="flex min-h-8 items-center gap-2 rounded-md text-xs cursor-pointer"
          >
            <User className="size-3.5 text-[#8b909a]" aria-hidden />
            <span>Account Settings</span>
          </DropdownMenuItem>

          <DropdownMenuItem asChild className="min-h-8 rounded-md text-xs">
            <a href="/settings" className="flex items-center gap-2 cursor-pointer">
              <Settings className="size-3.5 text-[#8b909a]" aria-hidden />
              <span>System Settings</span>
            </a>
          </DropdownMenuItem>

          <DropdownMenuSeparator className="bg-white/[0.06]" />

          <DropdownMenuItem
            variant="destructive"
            onSelect={(event) => {
              event.preventDefault();
              void logout();
            }}
            disabled={pending || busy}
            className="flex min-h-8 items-center gap-2 rounded-md text-xs text-[#f43f5e] focus:bg-[#f43f5e]/10 focus:text-[#f43f5e] cursor-pointer"
          >
            <LogOut className="size-3.5" aria-hidden />
            <span>{busy ? "Signing out…" : "Sign out"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="rounded-xl border border-white/[0.08] bg-[#0b0c0e] text-[#f3f4f6] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <User className="size-4 text-[#8b909a]" />
              <span>Account Settings</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8b909a]">
              Update your operator password and inspect session credentials.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-1">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-[#101216] p-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-[#161920] text-xs font-semibold text-white">
                  {username.slice(0, 2).toUpperCase()}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-semibold text-[#f3f4f6]">
                    {username}
                  </span>
                  <span className="font-mono text-[11px] text-[#8b909a]">
                    Role: {roleLabel ?? "user"}
                  </span>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-[#10b981]">
                <span className="size-1.5 rounded-full bg-[#10b981]" />
                Active
              </span>
            </div>

            <form onSubmit={handleChangePassword} className="flex flex-col gap-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[#c8ccd4]">
                <KeyRound className="size-3.5 text-[#8b909a]" />
                <span>Change Password</span>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-[#8b909a]">Current Password</label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  className="obsidian-input h-8 text-xs"
                  autoComplete="current-password"
                />
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#8b909a]">New Password</label>
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    className="obsidian-input h-8 text-xs"
                    autoComplete="new-password"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#8b909a]">Confirm Password</label>
                  <Input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    className="obsidian-input h-8 text-xs"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <DialogFooter className="mt-2 gap-2 sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsSettingsOpen(false)}
                  className="h-8 text-xs text-[#8b909a] hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isChangingPassword}
                  className="h-8 bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
                >
                  {isChangingPassword ? (
                    <>
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    "Update Password"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
