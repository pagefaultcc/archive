"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  Cookie,
  Moon,
  PanelLeft,
  Radio,
  ScrollText,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";

const ROUTE_META: Record<
  string,
  { title: string; icon: React.ComponentType<{ className?: string }> }
> = {
  "/": { title: "Overview", icon: PanelLeft },
  "/archives": { title: "Overview", icon: Archive },
  "/search": { title: "Search Vault", icon: Search },
  "/cookies": { title: "Cookies", icon: Cookie },
  "/validator": { title: "Validator", icon: CheckCircle2 },
  "/channels": { title: "Telegram Channels", icon: Radio },
  "/users": { title: "Users", icon: Users },
  "/roles": { title: "Roles & Permissions", icon: Shield },
  "/audit": { title: "Audit Log", icon: ScrollText },
  "/settings": { title: "Settings & Storage", icon: Settings },
};

function resolveRouteMeta(pathname: string) {
  if (ROUTE_META[pathname]) return ROUTE_META[pathname];
  if (pathname.startsWith("/archives")) return { title: "Overview", icon: Archive };
  if (pathname.startsWith("/search")) return { title: "Search Vault", icon: Search };
  if (pathname.startsWith("/cookies")) return { title: "Cookies", icon: Cookie };
  if (pathname.startsWith("/validator")) return { title: "Validator", icon: CheckCircle2 };
  if (pathname.startsWith("/channels")) return { title: "Telegram Channels", icon: Radio };
  if (pathname.startsWith("/users")) return { title: "Users", icon: Users };
  if (pathname.startsWith("/roles")) return { title: "Roles & Permissions", icon: Shield };
  if (pathname.startsWith("/audit")) return { title: "Audit Log", icon: ScrollText };
  if (pathname.startsWith("/settings")) return { title: "Settings & Storage", icon: Settings };
  return { title: "Overview", icon: PanelLeft };
}

export function HeaderTitle() {
  const pathname = usePathname();
  const { title, icon: RouteIcon } = resolveRouteMeta(pathname);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <RouteIcon className="size-4 shrink-0 text-neutral-400" />
      <p className="truncate text-sm font-medium text-white">{title}</p>
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
        const pageInput = document.querySelector<HTMLInputElement>("[data-vault-search-input]");
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
        <Search className="pointer-events-none absolute left-3 size-3.5 text-neutral-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search vault..."
          aria-label="Quick search vault"
          className="h-8 w-44 sm:w-60 rounded-full border border-white/[0.08] bg-[#0e0f11] pl-8 pr-14 text-xs text-white placeholder:text-neutral-500 transition-colors focus:border-white/20 focus:outline-none"
        />
        <kbd className="pointer-events-none absolute right-2.5 font-mono text-[10px] text-neutral-500 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/[0.06]">
          Ctrl K
        </kbd>
      </form>
      <div
        title="Obsidian Dark Theme Active"
        className="flex size-8 items-center justify-center rounded-full border border-white/[0.08] bg-[#0e0f11] text-neutral-400"
      >
        <Moon className="size-3.5" />
      </div>
    </div>
  );
}
