import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/components/app-sidebar";
import { HeaderTitle, HeaderQuickSearch } from "@/components/header-title";
import { PanelLeft } from "lucide-react";
import { RetryErrorBoundary } from "@/components/retry-error";
import { serverGetMe, type SessionUser } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Loads the session server-side. Renders the retryable error boundary on
 * infrastructure failure, redirects to /login when unauthenticated.
 */
export async function loadSession(): Promise<
  | { kind: "ok"; user: SessionUser }
  | { kind: "error" }
  | { kind: "unauthenticated" }
> {
  const cookieHeader = (await cookies()).toString();
  const result = await serverGetMe(cookieHeader);
  if (result.ok) return { kind: "ok", user: result.data.user };
  if (result.status === 401) return { kind: "unauthenticated" };
  return { kind: "error" };
}

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await loadSession();
  if (session.kind === "unauthenticated") {
    redirect("/login");
  }
  if (session.kind === "error") {
    return <RetryErrorBoundary />;
  }

  const user = session.user;
  const canReadUsers = user.permissions.includes("users:read");
  const canReadRoles = user.permissions.includes("roles:read");
  const canReadAudit = user.permissions.includes("audit:read");

  return (
    <SidebarProvider>
      <div className="relative flex min-h-screen w-full flex-col bg-[#030405] text-[#f7f8f8]">
        {/* SpinupMail Top Header */}
        <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#030405]/85 px-4 backdrop-blur-xl md:px-6 lg:px-8 transition-all">
          <div className="mx-auto flex h-14 min-w-0 w-full max-w-[1500px] items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/archives"
                className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors"
              >
                <PanelLeft className="size-4 text-neutral-400" />
                <span className="font-semibold text-sm tracking-tight text-white">Archive</span>
              </Link>
              <Separator orientation="vertical" className="h-4 bg-white/[0.08]" />
              <HeaderTitle />
            </div>

            <HeaderQuickSearch />
          </div>
        </header>

        {/* Main Content Area with bottom clearance for floating dock */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden px-4 pt-6 pb-28 md:px-6 lg:px-8">
          <div className="apple-tab-enter mx-auto flex min-h-0 min-w-0 w-full max-w-[1500px] flex-1 flex-col">
            {children}
          </div>
        </main>

        {/* Bottom Clear Glass Animated Island Dock */}
        <AppSidebar
          canReadUsers={canReadUsers}
          canReadRoles={canReadRoles}
          canReadAudit={canReadAudit}
          username={user.username}
          roleLabel={user.isRoot ? "root" : (user.roles[0] ?? "user")}
        />
      </div>
    </SidebarProvider>
  );
}
