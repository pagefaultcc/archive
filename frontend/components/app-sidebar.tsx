"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  Cookie,
  LayoutDashboard,
  Radio,
  ScrollText,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Icon3D } from "@/components/kinetics-ui";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

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

  const platformItems = [
    { href: "/archives", label: "Archives", icon: Archive },
    { href: "/search", label: "Search", icon: Search },
    { href: "/cookies", label: "Cookies", icon: Cookie },
  ];

  const moderationItems = [
    { href: "/channels", label: "Channels", icon: Radio },
    ...(canReadUsers ? [{ href: "/users", label: "Users", icon: Users }] : []),
    ...(canReadRoles ? [{ href: "/roles", label: "Roles", icon: Shield }] : []),
    ...(canReadAudit
      ? [{ href: "/audit", label: "Logs", icon: ScrollText }]
      : []),
  ];

  const systemItems = [
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <Sidebar collapsible="icon" variant="sidebar" className="app-shell">
      <SidebarHeader className="h-14 justify-center border-b border-border px-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Archive">
              <Link href="/" className="flex items-center gap-2.5">
                <Icon3D name="shield" size="sm" />
                <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-[14px] font-[590] text-[#ffffff]">
                    Archive
                  </span>
                  <span className="truncate text-[12px] text-[#8a8f98]">
                    Self-Hosted Vault
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          {/* Top level item: Overview */}
          <div className="pt-1">
            <SidebarMenu className="gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/"}
                  tooltip="Overview"
                >
                  <Link
                    href="/"
                    className={cn(
                      "app-nav-link spring-interactive rounded-[6px] text-[14px]",
                      pathname === "/" && "app-nav-active",
                    )}
                  >
                    <LayoutDashboard aria-hidden className="size-4" />
                    <span className="group-data-[collapsible=icon]:hidden">
                      Overview
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>

          {/* Section: Platform */}
          <SidebarGroupLabel className="mt-4 text-[12px] font-[510] text-[#62666d]">
            Platform
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {platformItems.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.label}
                    >
                      <Link
                        href={item.href}
                        className={cn(
                          "app-nav-link spring-interactive rounded-[6px] text-[14px]",
                          active && "app-nav-active",
                        )}
                      >
                        <item.icon aria-hidden className="size-4" />
                        <span className="group-data-[collapsible=icon]:hidden">
                          {item.label}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>

          {/* Section: Moderation */}
          {moderationItems.length > 0 ? (
            <>
              <SidebarGroupLabel className="mt-4 text-[12px] font-[510] text-[#62666d]">
                Moderation
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
                  {moderationItems.map((item) => {
                    const active = pathname.startsWith(item.href);
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={item.label}
                        >
                          <Link
                            href={item.href}
                            className={cn(
                              "app-nav-link spring-interactive rounded-[6px] text-[14px]",
                              active && "app-nav-active",
                            )}
                          >
                            <item.icon aria-hidden className="size-4" />
                            <span className="group-data-[collapsible=icon]:hidden">
                              {item.label}
                            </span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </>
          ) : null}

          {/* Section: System */}
          <SidebarGroupLabel className="mt-4 text-[12px] font-[510] text-[#62666d]">
            System
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {systemItems.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.label}
                    >
                      <Link
                        href={item.href}
                        className={cn(
                          "app-nav-link spring-interactive rounded-[6px] text-[14px]",
                          active && "app-nav-active",
                        )}
                      >
                        <item.icon aria-hidden className="size-4" />
                        <span className="group-data-[collapsible=icon]:hidden">
                          {item.label}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {username ? (
        <SidebarFooter className="border-t border-border p-2">
          <UserMenu username={username} roleLabel={roleLabel} />
        </SidebarFooter>
      ) : null}

      <SidebarRail />
    </Sidebar>
  );
}
