"use client";

import { useState } from "react";
import { FileText, KeyRound } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { GlobalSearchVault } from "@/components/global-search-vault";
import { PasswordsSearch } from "@/components/passwords-search";

export function SearchTabs() {
  const [tab, setTab] = useState<"files" | "passwords">("files");

  return (
    <div className="flex flex-1 flex-col gap-5">
      <SegmentedControl
        label="Search mode"
        value={tab}
        onValueChange={(value) => setTab(value as "files" | "passwords")}
        options={[
          { value: "files", label: "Files", icon: <FileText /> },
          { value: "passwords", label: "Passwords", icon: <KeyRound /> },
        ]}
        className="w-full sm:w-fit"
      />

      {/* Active Tab View */}
      {tab === "files" ? <GlobalSearchVault /> : <PasswordsSearch />}
    </div>
  );
}
