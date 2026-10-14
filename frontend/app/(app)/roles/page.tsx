import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serverGetMe, serverListRoles, serverListPermissions } from "@/lib/api";
import { RetryErrorBoundary } from "@/components/retry-error";
import { RolesManager } from "@/components/roles-manager";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const cookieHeader = (await cookies()).toString();
  const me = await serverGetMe(cookieHeader);
  if (!me.ok && me.status === 401) {
    redirect("/login");
  }
  if (!me.ok) {
    return <RetryErrorBoundary />;
  }

  const actorPermissions = me.data.user.permissions;
  if (!actorPermissions.includes("roles:read")) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-6xl font-semibold tracking-tight">403</h1>
        <p className="text-muted-foreground">
          You do not have permission to view this page.
        </p>
      </main>
    );
  }

  const [rolesResult, permissionsResult] = await Promise.all([
    serverListRoles(cookieHeader),
    serverListPermissions(cookieHeader),
  ]);
  if (!rolesResult.ok || !permissionsResult.ok) {
    if (
      (rolesResult.ok === false && rolesResult.status === 401) ||
      (permissionsResult.ok === false && permissionsResult.status === 401)
    ) {
      redirect("/login");
    }
    return <RetryErrorBoundary />;
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <RolesManager
        roles={rolesResult.data.roles}
        permissions={permissionsResult.data.permissions}
        actorPermissions={actorPermissions}
      />
    </div>
  );
}
