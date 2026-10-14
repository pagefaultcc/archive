import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serverGetMe, serverListAudit } from "@/lib/api";
import { RetryErrorBoundary } from "@/components/retry-error";
import { AuditViewer } from "@/components/audit-viewer";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const cookieHeader = (await cookies()).toString();
  const me = await serverGetMe(cookieHeader);
  if (!me.ok && me.status === 401) {
    redirect("/login");
  }
  if (!me.ok) {
    return <RetryErrorBoundary />;
  }

  if (!me.data.user.permissions.includes("audit:read")) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-6xl font-semibold tracking-tight">403</h1>
        <p className="text-muted-foreground">
          You do not have permission to view this page.
        </p>
      </main>
    );
  }

  const auditPage = await serverListAudit(cookieHeader, { limit: 25 });
  if (!auditPage.ok) {
    if (auditPage.status === 401) {
      redirect("/login");
    }
    return <RetryErrorBoundary />;
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <AuditViewer initialPage={auditPage.data} />
    </div>
  );
}
