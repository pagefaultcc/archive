"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  Cookie,
  CreditCard,
  Layers,
  Radio,
  ScrollText,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

export function AppSidebar({
  canReadUsers,
  canReadRoles = false,
  canReadAudit = false,
  username,
  roleLabel,
}: {
  canReadUsers: boolean;
  canReadRoles?: boolean;
  canReadAudit?: boolean;
  username?: string;
  roleLabel?: string;
}) {
  const pathname = usePathname();

  const workspaceItems: NavItem[] = [
    { href: "/archives", label: "Archives", icon: Archive },
    { href: "/search", label: "Search", icon: Search },
  ];

  const intelligenceItems: NavItem[] = [
    { href: "/cookies", label: "Cookies", icon: Cookie },
    { href: "/cards", label: "Cards", icon: CreditCard },
    { href: "/validator", label: "Validator", icon: CheckCircle2 },
    { href: "/channels", label: "Channels", icon: Radio },
  ];

  const adminItems: NavItem[] = [
    ...(canReadUsers ? [{ href: "/users", label: "Users", icon: Users }] : []),
    ...(canReadRoles ? [{ href: "/roles", label: "Roles", icon: Shield }] : []),
    ...(canReadAudit ? [{ href: "/audit", label: "Logs", icon: ScrollText }] : []),
  ];

  const systemItems: NavItem[] = [
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  const groups: NavGroup[] = [
    { title: "Workspace", items: workspaceItems },
    { title: "Intelligence", items: intelligenceItems },
    ...(adminItems.length > 0 ? [{ title: "Administration", items: adminItems }] : []),
    { title: "System", items: systemItems },
  ];

  return (
    <aside
      aria-label="Workspace navigation"
      className="sticky top-0 z-40 flex w-full shrink-0 flex-col border-b border-white/[0.06] bg-[#08090b] md:h-screen md:w-56 md:border-r md:border-b-0"
    >
      {/* Brand Header */}
      <div className="flex h-13 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
        <Link
          href="/archives"
          className="flex items-center gap-2.5 text-[#f3f4f6] transition-colors hover:text-white"
        >
          <span className="flex size-7 items-center justify-center rounded-md border border-white/[0.1] bg-[#111318] text-[#f3f4f6]">
            <Layers className="size-3.5" />
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight">Archive</span>
            <span className="font-mono text-[10px] text-[#5c606a]">v2.5</span>
          </div>
        </Link>

        {username ? (
          <div className="md:hidden">
            <UserMenu username={username} roleLabel={roleLabel} compact={true} />
          </div>
        ) : null}
      </div>

      {/* Navigation Sections */}
      <nav className="flex flex-1 flex-row items-center gap-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-col md:items-stretch md:gap-5 md:overflow-y-auto md:px-3 md:py-4">
        {groups.map((group) => (
          <div
            key={group.title}
            className="flex shrink-0 flex-row items-center gap-1 md:flex-col md:items-stretch md:gap-0.5"
          >
            <p className="hidden px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#5c606a] md:block">
              {group.title}
            </p>
            {group.items.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap",
                    isActive
                      ? "bg-white/[0.06] text-[#f3f4f6]"
                      : "text-[#8b909a] hover:bg-white/[0.025] hover:text-[#e5e7eb]",
                  )}
                >
                  {isActive ? (
                    <span
                      aria-hidden
                      className="hidden md:block absolute left-0 top-1/2 -translate-y-1/2 h-3.5 w-[2px] rounded-full bg-[#f3f4f6]"
                    />
                  ) : null}
                  <item.icon
                    className={cn(
                      "size-3.5 shrink-0 transition-colors",
                      isActive ? "text-[#f3f4f6]" : "text-[#6b707b] group-hover:text-[#c8ccd4]",
                    )}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom Operator Profile Card (Desktop) */}
      {username ? (
        <div className="hidden border-t border-white/[0.06] p-3 md:block">
          <UserMenu username={username} roleLabel={roleLabel} compact={false} />
        </div>
      ) : null}
    </aside>
  );
}

export const BottomIslandDock = AppSidebar;
