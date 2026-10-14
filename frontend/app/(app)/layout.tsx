import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/components/app-sidebar";
import { HeaderTitle } from "@/components/header-title";
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
      <AppSidebar
        canReadUsers={canReadUsers}
        canReadRoles={canReadRoles}
        canReadAudit={canReadAudit}
        username={user.username}
        roleLabel={user.isRoot ? "root" : (user.roles[0] ?? "user")}
      />
      <SidebarInset className="app-shell">
        <header className="sticky top-0 z-[995] border-b border-border bg-[#08090a]/90 px-4 backdrop-blur-md md:px-6 lg:px-8">
          <div className="mx-auto flex h-14 min-w-0 w-full max-w-[1440px] items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="-ml-1.5" />
              <Separator orientation="vertical" className="h-4" />
              <HeaderTitle />
            </div>
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden px-4 py-6 md:px-6 lg:px-8">
          <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-[1440px] flex-1 flex-col">
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
