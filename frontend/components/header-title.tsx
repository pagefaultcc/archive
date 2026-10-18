"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";

const ROUTE_META: Record<
  string,
  { section: string; title: string; subtitle: string }
> = {
  "/": {
    section: "Workspace",
    title: "Archives",
    subtitle: "Indexed container vault & ingestion pipeline",
  },
  "/archives": {
    section: "Workspace",
    title: "Archives",
    subtitle: "Indexed container vault & ingestion pipeline",
  },
  "/search": {
    section: "Workspace",
    title: "Global Search",
    subtitle: "Cross-archive file & credential index",
  },
  "/cookies": {
    section: "Intelligence",
    title: "Cookies Explorer",
    subtitle: "Root-domain normalized Netscape & JSON stores",
  },
  "/validator": {
    section: "Intelligence",
    title: "Session Validator",
    subtitle: "Automated session token verification",
  },
  "/channels": {
    section: "Intelligence",
    title: "Telegram Channels",
    subtitle: "MTProto UserBot ingestion & extraction rules",
  },
  "/users": {
    section: "Administration",
    title: "Users",
    subtitle: "Operator directory & account access",
  },
  "/roles": {
    section: "Administration",
    title: "Roles & Permissions",
    subtitle: "RBAC role definitions & capability grants",
  },
  "/audit": {
    section: "Administration",
    title: "Audit Log",
    subtitle: "Append-only security event ledger",
  },
  "/settings": {
    section: "System",
    title: "Settings & Storage",
    subtitle: "Disk allocation, password dictionary & reindexing",
  },
};

function resolveRouteMeta(pathname: string) {
  if (ROUTE_META[pathname]) return ROUTE_META[pathname];
  if (pathname.startsWith("/archives/")) {
    return {
      section: "Workspace",
      title: "Archive Inspector",
      subtitle: "Zero-extraction directory tree & file preview",
    };
  }
  for (const key of Object.keys(ROUTE_META)) {
    if (key !== "/" && pathname.startsWith(key)) {
      return ROUTE_META[key];
    }
  }
  return ROUTE_META["/archives"];
}

export function HeaderTitle() {
  const pathname = usePathname();
  const { section, title, subtitle } = resolveRouteMeta(pathname);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="hidden font-medium text-[#5c606a] sm:inline">
          {section}
        </span>
        <span className="hidden text-[#3a3d45] sm:inline">/</span>
        <span className="truncate text-sm font-semibold tracking-tight text-[#f3f4f6]">
          {title}
        </span>
      </div>
      <span className="hidden h-3.5 w-[1px] bg-white/[0.07] lg:inline-block" />
      <span className="hidden truncate text-xs text-[#6b707b] lg:inline">
        {subtitle}
      </span>
    </div>
  );
}

export function HeaderQuickSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const pageInput = document.querySelector<HTMLInputElement>(
          "[data-vault-search-input]",
        );
        if (pageInput) {
          pageInput.focus();
          pageInput.select();
        } else {
          inputRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    } else if (!pathname.startsWith("/search")) {
      router.push("/search");
    }
  }

  return (
    <div className="flex items-center gap-2.5">
      <form onSubmit={handleSubmit} className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 size-3.5 text-[#6b707b]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to search..."
          aria-label="Quick search vault"
          className="obsidian-input h-8 w-44 pl-8 pr-14 text-xs sm:w-64"
        />
        <kbd className="pointer-events-none absolute right-2 rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-[#6b707b]">
          Ctrl K
        </kbd>
      </form>
    </div>
  );
}
