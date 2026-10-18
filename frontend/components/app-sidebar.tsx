"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  Cookie,
  Radio,
  ScrollText,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import { Icon3D } from "@/components/kinetics-ui";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tag?: string;
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
  const navigationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const navigation = navigationRef.current;
    if (navigation && navigation.scrollWidth > navigation.clientWidth) {
      navigation.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
        behavior: "instant",
        block: "nearest",
        inline: "center",
      });
    }
  }, [pathname]);

  const coreItems: NavItem[] = [
    { href: "/archives", label: "Archives", icon: Archive },
    { href: "/search", label: "Search", icon: Search },
    { href: "/cookies", label: "Cookies", icon: Cookie },
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

  return (
    <nav
      aria-label="Application dock navigation"
      className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] inset-x-0 mx-auto w-fit max-w-[calc(100%-2rem)] z-50 pointer-events-none select-none transition-all duration-300"
    >
      <div
        className={cn(
          "pointer-events-auto relative flex max-w-full items-center gap-1 sm:gap-1.5 px-3 py-2 rounded-full",
          "border border-white/[0.08] bg-[#0a0b0c]/85",
          "backdrop-blur-2xl backdrop-saturate-150",
          "shadow-[0_16px_50px_rgba(0,0,0,0.65)]",
          "transition-all duration-300 ease-out"
        )}
      >
        <div
          ref={navigationRef}
          className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain py-2 -my-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:gap-1.5 sm:overflow-visible"
          onFocusCapture={(event) => {
            if (event.currentTarget.scrollWidth > event.currentTarget.clientWidth) {
              event.target.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
            }
          }}
        >
        {/* Brand Home Icon */}
        <div className="group relative flex shrink-0 flex-col items-center">
          <div
            role="tooltip"
            className="hidden sm:block absolute -top-10 left-1/2 -translate-x-1/2 pointer-events-none opacity-0 translate-y-1.5 scale-90 group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] z-50 whitespace-nowrap"
          >
            <div className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight text-[#f7f8f8] bg-[#121316]/90 backdrop-blur-xl border border-white/[0.16] shadow-[0_6px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)]">
              <span>Archive Home</span>
            </div>
          </div>
          <Link
            href="/archives"
            aria-label="Archive Home"
            className={cn(
              "flex size-9 sm:size-10 items-center justify-center rounded-full transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
              "hover:scale-115 hover:bg-white/[0.08] active:scale-95"
            )}
          >
            <Icon3D name="shield" size="xs" />
            <span className="sr-only">Archive</span>
          </Link>
        </div>

        {/* Divider */}
        <div className="h-5 w-[1px] bg-white/[0.1] mx-0.5 shrink-0" />

        {/* Core Vault Items */}
        {coreItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <div key={item.href} className="group relative flex shrink-0 flex-col items-center">
              {/* Floating Apple Island Tooltip */}
              <div
                role="tooltip"
                className="hidden sm:block absolute -top-10 left-1/2 -translate-x-1/2 pointer-events-none opacity-0 translate-y-1.5 scale-90 group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] z-50 whitespace-nowrap"
              >
                <div className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight text-[#f7f8f8] bg-[#121316]/90 backdrop-blur-xl border border-white/[0.16] shadow-[0_6px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)]">
                  <span>{item.label}</span>
                </div>
              </div>

              {/* Icon Button */}
              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex size-9 sm:size-10 items-center justify-center rounded-full transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                  "hover:scale-115 hover:bg-white/[0.08] active:scale-95",
                  isActive
                    ? "bg-white/[0.14] text-[#f7f8f8] shadow-[inset_0_1px_1px_rgba(255,255,255,0.22)]"
                    : "text-[#8a8f98] hover:text-[#f7f8f8]"
                )}
              >
                <item.icon className="size-4.5 transition-transform duration-200" />
                {isActive ? (
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 size-1 rounded-full bg-[#00ba7c] shadow-[0_0_6px_rgba(0,186,124,0.35)]" />
                ) : null}
              </Link>
            </div>
          );
        })}

        {/* Admin Navigation Group */}
        {adminItems.length > 0 ? (
          <>
            <div className="h-5 w-[1px] bg-white/[0.1] mx-0.5 shrink-0" />
            {adminItems.map((item) => {
              const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <div key={item.href} className="group relative flex shrink-0 flex-col items-center">
                  <div
                    role="tooltip"
                    className="hidden sm:block absolute -top-10 left-1/2 -translate-x-1/2 pointer-events-none opacity-0 translate-y-1.5 scale-90 group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] z-50 whitespace-nowrap"
                  >
                    <div className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight text-[#f7f8f8] bg-[#121316]/90 backdrop-blur-xl border border-white/[0.16] shadow-[0_6px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)]">
                      <span>{item.label}</span>
                    </div>
                  </div>

                  <Link
                    href={item.href}
                    aria-label={item.label}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative flex size-9 sm:size-10 items-center justify-center rounded-full transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                      "hover:scale-115 hover:bg-white/[0.08] active:scale-95",
                      isActive
                        ? "bg-white/[0.14] text-[#f7f8f8] shadow-[inset_0_1px_1px_rgba(255,255,255,0.22)]"
                        : "text-[#8a8f98] hover:text-[#f7f8f8]"
                    )}
                  >
                    <item.icon className="size-4.5 transition-transform duration-200" />
                    {isActive ? (
                      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 size-1 rounded-full bg-[#00ba7c] shadow-[0_0_6px_rgba(0,186,124,0.35)]" />
                    ) : null}
                  </Link>
                </div>
              );
            })}
          </>
        ) : null}

        {/* System & Settings */}
        <div className="h-5 w-[1px] bg-white/[0.1] mx-0.5 shrink-0" />
        {systemItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <div key={item.href} className="group relative flex shrink-0 flex-col items-center">
              <div
                role="tooltip"
                className="hidden sm:block absolute -top-10 left-1/2 -translate-x-1/2 pointer-events-none opacity-0 translate-y-1.5 scale-90 group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] z-50 whitespace-nowrap"
              >
                <div className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight text-[#f7f8f8] bg-[#121316]/90 backdrop-blur-xl border border-white/[0.16] shadow-[0_6px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)]">
                  <span>{item.label}</span>
                </div>
              </div>

              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex size-9 sm:size-10 items-center justify-center rounded-full transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                  "hover:scale-115 hover:bg-white/[0.08] active:scale-95",
                  isActive
                    ? "bg-white/[0.14] text-[#f7f8f8] shadow-[inset_0_1px_1px_rgba(255,255,255,0.22)]"
                    : "text-[#8a8f98] hover:text-[#f7f8f8]"
                )}
              >
                <item.icon className="size-4.5 transition-transform duration-200" />
                {isActive ? (
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 size-1 rounded-full bg-[#00ba7c] shadow-[0_0_6px_rgba(0,186,124,0.35)]" />
                ) : null}
              </Link>
            </div>
          );
        })}
        </div>

        {/* User Profile / Menu */}
        {username ? (
          <>
            <div className="h-5 w-[1px] bg-white/[0.1] mx-0.5 shrink-0" />
            <div className="group relative flex shrink-0 flex-col items-center">
              <div
                role="tooltip"
                className="hidden sm:block group-has-[[data-state=open]]:hidden absolute -top-10 left-1/2 -translate-x-1/2 pointer-events-none opacity-0 translate-y-1.5 scale-90 group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] z-50 whitespace-nowrap"
              >
                <div className="flex max-w-64 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight text-[#f7f8f8] bg-[#121316]/90 backdrop-blur-xl border border-white/[0.16] shadow-[0_6px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.2)]">
                  <span className="truncate">{username} ({roleLabel ?? "user"})</span>
                </div>
              </div>
              <UserMenu username={username} roleLabel={roleLabel} compact={true} />
            </div>
          </>
        ) : null}
      </div>
    </nav>
  );
}

export const BottomIslandDock = AppSidebar;
