"use client";

import { usePathname } from "next/navigation";

const ROUTE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/archives": "Archives",
  "/search": "Search Vault",
  "/cookies": "Cookies",
  "/channels": "Telegram Channels",
  "/roles": "Roles & Permissions",
  "/audit": "Audit Log",
  "/settings": "Settings & Storage",
};

export function HeaderTitle() {
  const pathname = usePathname();
  const title =
    ROUTE_TITLES[pathname] ??
    (pathname.startsWith("/archives")
      ? "Archives"
      : pathname.startsWith("/search")
        ? "Search Vault"
        : pathname.startsWith("/cookies")
          ? "Cookies"
        : pathname.startsWith("/channels")
          ? "Telegram Channels"
        : pathname.startsWith("/users")
          ? "Users"
          : pathname.startsWith("/roles")
            ? "Roles & Permissions"
            : pathname.startsWith("/audit")
              ? "Audit Log"
              : pathname.startsWith("/settings")
                ? "Settings & Storage"
                : "Overview");
  return (
    <div className="flex min-w-0 items-center gap-2">
      <p className="truncate text-sm font-medium">{title}</p>
    </div>
  );
}
