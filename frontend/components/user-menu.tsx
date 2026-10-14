"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, LogOut, Settings, ShieldCheck } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { browserLogout } from "@/lib/api";

export function UserMenu({
  username,
  roleLabel,
}: {
  username: string;
  roleLabel?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    const result = await browserLogout();
    if (result.ok || result.status === 401) {
      startTransition(() => router.replace("/login"));
    } else {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending || busy}
          className="flex w-full items-center gap-2.5 rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] px-2.5 py-2 text-left transition-colors hover:border-[rgba(255,255,255,0.08)] hover:bg-[rgba(255,255,255,0.05)] focus-visible:outline-2 focus-visible:outline-[rgba(255,255,255,0.15)] disabled:opacity-50"
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="min-w-52 rounded-[8px] border-[rgba(255,255,255,0.08)] bg-[#0f1011] text-[#f7f8f8]"
      >
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2.5 px-2.5 py-2 text-left">
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[11px] font-[590] text-[#ffffff]"
            >
              {username.slice(0, 2).toUpperCase()}
            </span>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate text-[13px] font-[510] text-[#ffffff]">
                {username}
              </span>
              <span className="flex items-center gap-1 truncate text-[12px] text-[#8a8f98]">
                <ShieldCheck className="size-3" aria-hidden />
                {roleLabel ?? "Authenticated session"}
              </span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-[rgba(255,255,255,0.05)]" />
        <DropdownMenuItem asChild>
          <a href="/settings" className="flex items-center gap-2 cursor-pointer">
            <Settings className="size-4" aria-hidden />
            <span>Settings</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.preventDefault();
            void logout();
          }}
        >
          <LogOut aria-hidden /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
