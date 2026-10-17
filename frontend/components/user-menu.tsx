"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
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
  DropdownMenuArrow,
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
import { Badge } from "@/components/ui/badge";
import { browserChangePassword, browserLogout } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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
  const passwordFieldId = useId();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  // User Settings Modal state
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
              className="relative flex size-9 shrink-0 sm:size-10 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-[11px] font-semibold text-[#f7f8f8] transition-none hover:bg-white/[0.1] hover:border-white/25 data-[state=open]:bg-white/[0.08] data-[state=open]:border-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 cursor-pointer shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]"
            >
              <span className="truncate">{username.slice(0, 2).toUpperCase()}</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || busy}
              className="flex w-full items-center gap-2.5 rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] px-2.5 py-2 text-left transition-none hover:border-[rgba(255,255,255,0.08)] hover:bg-[rgba(255,255,255,0.05)] focus-visible:outline-2 focus-visible:outline-[rgba(255,255,255,0.15)] disabled:opacity-50"
            >
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[11px] font-[590] text-[#ffffff]"
              >
                {username.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                <p className="truncate text-[13px] font-[510] text-[#f7f8f8]">
                  {username}
                </p>
                <p className="truncate text-[12px] text-[#8a8f98]">
                  Role: {roleLabel ?? "user"}
                </p>
              </div>
              <ChevronsUpDown
                aria-hidden
                className="size-3.5 shrink-0 text-[#62666d] group-data-[collapsible=icon]:hidden"
              />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align={compact ? "center" : "start"}
          sideOffset={compact ? 12 : 6}
          collisionPadding={compact ? 16 : undefined}
          arrowPadding={compact ? 12 : undefined}
          className={cn(
            "min-w-0 max-w-[calc(100vw-2rem)] rounded-[10px] border border-white/[0.12] bg-[#0c0d0e]/95 text-[#f7f8f8] backdrop-blur-2xl shadow-[0_16px_40px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.15)] transition-none data-[state=open]:animate-none data-[state=closed]:animate-none",
            compact ? "w-56 overflow-visible p-0" : "w-64",
          )}
        >
          <div
            className={cn(
              compact && "max-h-[calc(var(--radix-dropdown-menu-content-available-height)-2px)] overflow-x-hidden overflow-y-auto rounded-[9px] p-1",
            )}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2.5 px-3 py-2.5 text-left">
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.05] text-[12px] font-semibold text-white shadow-inner"
                >
                  {username.slice(0, 2).toUpperCase()}
                </span>
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate text-[13px] font-semibold text-white">
                    {username}
                  </span>
                  <span className="flex min-w-0 items-center gap-1 text-[11px] text-[#8a8f98]">
                    <ShieldCheck className="size-3 shrink-0 text-[#00ba7c]" aria-hidden />
                    <span className="truncate">{roleLabel ?? "Authenticated session"}</span>
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-white/[0.06]" />

            {/* User Account Settings */}
            <DropdownMenuItem
              onSelect={() => setIsSettingsOpen(true)}
              className="flex min-h-9 items-center gap-2 cursor-pointer text-xs transition-none"
            >
              <User className="size-3.5 text-[#8a8f98]" aria-hidden />
              <span>User Settings</span>
            </DropdownMenuItem>

            {/* System Settings Link */}
            <DropdownMenuItem asChild className="min-h-9 text-xs transition-none">
              <a href="/settings" className="flex items-center gap-2 cursor-pointer">
                <Settings className="size-3.5 text-[#8a8f98]" aria-hidden />
                <span>System Settings</span>
              </a>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="bg-white/[0.06]" />

            {/* Instant Logout */}
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault();
                void logout();
              }}
              disabled={pending || busy}
              className="flex min-h-9 items-center gap-2 cursor-pointer text-xs text-[#f91880] transition-none focus:bg-[rgba(249,24,128,0.1)] focus:text-[#f91880]"
            >
              <LogOut className="size-3.5" aria-hidden />
              <span>{busy ? "Signing out…" : "Log out"}</span>
            </DropdownMenuItem>
          </div>
          {compact && (
            <DropdownMenuArrow
              width={12}
              height={6}
              className="fill-[#0c0d0e]/95 stroke-white/[0.12]"
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* User Settings Clear Glass Modal */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[10px] border border-white/[0.12] bg-[#0c0d0e]/95 backdrop-blur-2xl sm:max-w-md text-[#f7f8f8] shadow-[0_16px_50px_rgba(0,0,0,0.6)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <User className="size-4 text-[#8a8f98]" />
              <span>User Account Settings</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-[#8a8f98]">
              Manage your personal credentials, session security, and account preferences.
            </DialogDescription>
          </DialogHeader>

          {/* Account Profile Details */}
          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col items-start gap-3 rounded-[8px] border border-white/[0.08] bg-black/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex w-full min-w-0 items-center gap-2.5 sm:w-auto sm:flex-1">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] border border-white/[0.12] text-xs font-semibold text-white">
                  {username.slice(0, 2).toUpperCase()}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="break-all text-xs font-semibold text-white">{username}</span>
                  <span className="break-all text-[11px] text-[#8a8f98]">Account Role: {roleLabel ?? "user"}</span>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono border-[rgba(0,186,124,0.3)] bg-[rgba(0,186,124,0.1)] text-[#00ba7c]">
                Active Session
              </Badge>
            </div>

            {/* Change Password Form */}
            <form onSubmit={handleChangePassword} className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#d0d6e0]">
                <KeyRound className="size-3.5 text-[#8a8f98]" />
                <span>Change Password</span>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor={`${passwordFieldId}-current`} className="text-[11px] text-[#8a8f98]">Current Password</label>
                <Input
                  id={`${passwordFieldId}-current`}
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="h-9 rounded-[6px] bg-black/40 border-white/[0.12] text-xs"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${passwordFieldId}-new`} className="text-[11px] text-[#8a8f98]">New Password</label>
                  <Input
                    id={`${passwordFieldId}-new`}
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    className="h-9 rounded-[6px] bg-black/40 border-white/[0.12] text-xs"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor={`${passwordFieldId}-confirm`} className="text-[11px] text-[#8a8f98]">Confirm New</label>
                  <Input
                    id={`${passwordFieldId}-confirm`}
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    className="h-9 rounded-[6px] bg-black/40 border-white/[0.12] text-xs"
                  />
                </div>
              </div>

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsSettingsOpen(false)}
                  className="h-9 text-xs text-[#8a8f98] transition-none hover:scale-100 active:scale-100"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isChangingPassword}
                  className="h-9 gap-1.5 cursor-pointer transition-none hover:scale-100 active:scale-100"
                >
                  {isChangingPassword ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Save Password
                </Button>
              </DialogFooter>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
