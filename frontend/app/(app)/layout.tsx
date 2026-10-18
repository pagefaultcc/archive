import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { HeaderTitle, HeaderQuickSearch } from "@/components/header-title";
import { RetryErrorBoundary } from "@/components/retry-error";
import { serverGetMe, type SessionUser } from "@/lib/api";

export const dynamic = "force-dynamic";

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
      <div className="flex min-h-screen w-full flex-col bg-[#050506] text-[#f3f4f6] md:flex-row">
        {/* Architectural Obsidian Left Sidebar Rail */}
        <AppSidebar
          canReadUsers={canReadUsers}
          canReadRoles={canReadRoles}
          canReadAudit={canReadAudit}
          username={user.username}
          roleLabel={user.isRoot ? "root" : (user.roles[0] ?? "user")}
        />

        {/* Primary Workspace Column */}
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          {/* Top Command Bar */}
          <header className="sticky top-0 z-30 flex h-13 shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] bg-[#050506]/90 px-4 backdrop-blur-md sm:px-6 lg:px-8">
            <HeaderTitle />
            <HeaderQuickSearch />
          </header>

          {/* Main Workspace Canvas */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-[1480px] flex-1 flex-col">
              {children}
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
