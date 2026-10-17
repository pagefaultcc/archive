"use client";

import { useState } from "react";
import { FileText, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlobalSearchVault } from "@/components/global-search-vault";
import { PasswordsSearch } from "@/components/passwords-search";
import { cn } from "@/lib/utils";

export function SearchTabs() {
  const [tab, setTab] = useState<"files" | "passwords">("files");

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* Search Mode Pill Switcher */}
      <div className="flex items-center gap-1.5 rounded-full border border-[rgba(255,255,255,0.06)] bg-[#0f1011] p-1 w-fit">
        <Button
          type="button"
          size="sm"
          variant={tab === "files" ? "secondary" : "ghost"}
          onClick={() => setTab("files")}
          className={cn(
            "h-8 gap-1.5 px-4 text-xs font-medium rounded-full transition-none",
            tab === "files"
              ? "bg-[rgba(255,255,255,0.08)] text-[#ffffff] border-[rgba(255,255,255,0.1)] shadow-none"
              : "text-[#8a8f98] hover:text-[#d0d6e0]",
          )}
        >
          <FileText className="size-3.5" />
          Files
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === "passwords" ? "secondary" : "ghost"}
          onClick={() => setTab("passwords")}
          className={cn(
            "h-8 gap-1.5 px-4 text-xs font-medium rounded-full transition-none",
            tab === "passwords"
              ? "bg-[rgba(255,255,255,0.08)] text-[#ffffff] border-[rgba(255,255,255,0.1)] shadow-none"
              : "text-[#8a8f98] hover:text-[#d0d6e0]",
          )}
        >
          <KeyRound className="size-3.5" />
          Passwords
        </Button>
      </div>

      {/* Active Tab View */}
      {tab === "files" ? <GlobalSearchVault /> : <PasswordsSearch />}
    </div>
  );
}
