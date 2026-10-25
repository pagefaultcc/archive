"use client";

import { useState } from "react";
import { CreditCard, FileText, KeyRound } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { GlobalSearchVault } from "@/components/global-search-vault";
import { PasswordsSearch } from "@/components/passwords-search";
import { CardsSearch } from "@/components/cards-search";

export function SearchTabs() {
  const [tab, setTab] = useState<"files" | "passwords" | "cards">("files");

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label="Search mode"
          value={tab}
          onValueChange={(value) => setTab(value as "files" | "passwords" | "cards")}
          options={[
            { value: "files", label: "File Index", icon: <FileText /> },
            { value: "passwords", label: "Credential Index", icon: <KeyRound /> },
            { value: "cards", label: "Card Index", icon: <CreditCard /> },
          ]}
          className="w-full sm:w-fit"
        />
        <span className="hidden font-mono text-[11px] text-[#6b707b] sm:inline">
          PostgreSQL Trigram GIN · Zero-Extraction Stream
        </span>
      </div>

      <div className={tab === "files" ? "block" : "hidden"}>
        <GlobalSearchVault />
      </div>
      <div className={tab === "passwords" ? "block" : "hidden"}>
        <PasswordsSearch />
      </div>
      <div className={tab === "cards" ? "block" : "hidden"}>
        <CardsSearch />
      </div>
    </div>
  );
}
