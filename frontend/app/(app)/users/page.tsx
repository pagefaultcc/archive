import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AddUserDialog } from "@/components/add-user-dialog";
import { UserRowActions } from "@/components/user-row-actions";
import { RetryErrorBoundary } from "@/components/retry-error";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { serverGetMe, serverListRoles, serverListUsers } from "@/lib/api";
import type { PublicUser, RoleItem } from "@/lib/api";

export const dynamic = "force-dynamic";

const dateParser = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

type UsersPageProps = {
  searchParams?: Promise<{ deleted?: string }>;
};

function Avatar({ username }: { username: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-[#14171d] text-[10px] font-semibold text-[#f3f4f6]"
    >
      {username.slice(0, 2).toUpperCase()}
    </span>
  );
}

function StatusBadge({ user }: { user: PublicUser }) {
  if (user.deletedAt) {
    return <Badge variant="destructive">deleted</Badge>;
  }
  if (user.status === "suspended") {
    return <Badge variant="outline">suspended</Badge>;
  }
  return <Badge variant="secondary">active</Badge>;
}

function RolePills({ roles }: { roles: string[] }) {
  if (roles.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap gap-1">
      {roles.map((role) => (
        <Badge
          key={role}
          variant="outline"
          className="max-w-full whitespace-normal break-all text-left font-mono text-[10.5px]"
        >
          {role}
        </Badge>
      ))}
    </span>
  );
}

function AccessDenied() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-5xl font-semibold tracking-tight">403</h1>
      <p className="text-muted-foreground">
        You do not have permission to view this page.
      </p>
    </main>
  );
}

type UserListProps = {
  users: PublicUser[];
  permissions: string[];
  availableRoles: RoleItem[];
};

function UsersTable({ users, permissions, availableRoles }: UserListProps) {
  return (
    <div className="obsidian-panel hidden overflow-hidden md:block">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-white/[0.06] bg-[#101216]/70 hover:bg-transparent">
            <TableHead className="text-xs text-[#8b909a]">User</TableHead>
            <TableHead className="text-xs text-[#8b909a]">Status</TableHead>
            <TableHead className="text-xs text-[#8b909a]">Roles</TableHead>
            <TableHead className="text-xs text-[#8b909a]">Created</TableHead>
            <TableHead className="text-right text-xs text-[#8b909a]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id} className="border-b border-white/[0.04]">
              <TableCell>
                <span className="flex items-center gap-2.5">
                  <Avatar username={user.username} />
                  <span
                    className="max-w-64 truncate text-xs font-medium text-[#f3f4f6]"
                    title={user.username}
                  >
                    {user.username}
                  </span>
                  {user.isRoot ? (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      root
                    </Badge>
                  ) : null}
                  <span className="font-mono text-[11px] text-[#6b707b]">
                    {user.id.slice(0, 8)}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge user={user} />
              </TableCell>
              <TableCell>
                <RolePills roles={user.roles} />
              </TableCell>
              <TableCell className="font-mono text-xs text-[#8b909a]">
                {`${dateParser.format(new Date(user.createdAt))} UTC`}
              </TableCell>
              <TableCell className="text-right">
                <UserRowActions
                  user={user}
                  permissions={permissions}
                  availableRoles={availableRoles}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function UsersStack({ users, permissions, availableRoles }: UserListProps) {
  return (
    <div className="grid gap-3 md:hidden">
      {users.map((user) => (
        <Card key={user.id} className="obsidian-panel">
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Avatar username={user.username} />
              <span className="min-w-0 break-all text-xs font-medium">
                {user.username}
              </span>
              {user.isRoot ? <Badge variant="outline">root</Badge> : null}
              <StatusBadge user={user} />
            </div>
            <p className="text-xs text-muted-foreground">
              ID: <span className="font-mono">{user.id.slice(0, 8)}</span>
            </p>
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Roles: <RolePills roles={user.roles} />
            </div>
            <p className="text-xs text-muted-foreground">
              Created: {`${dateParser.format(new Date(user.createdAt))} UTC`}
            </p>
            <div>
              <UserRowActions
                user={user}
                permissions={permissions}
                availableRoles={availableRoles}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default async function UsersPage({ searchParams }: UsersPageProps) {
  const search = (await searchParams) ?? {};
  const showDeleted = search.deleted === "1";

  const cookieHeader = (await cookies()).toString();
  const me = await serverGetMe(cookieHeader);
  if (!me.ok && me.status === 401) {
    redirect("/login");
  }
  if (!me.ok) {
    return <RetryErrorBoundary />;
  }

  const permissions = me.data.user.permissions;
  const canReadUsers = permissions.includes("users:read");
  const canCreateUsers = permissions.includes("users:create");

  if (!canReadUsers) {
    return <AccessDenied />;
  }

  const canListRoles =
    permissions.includes("roles:read") ||
    permissions.includes("users:manage_roles");
  let availableRoles: RoleItem[] = [];
  if (canListRoles) {
    const rolesResult = await serverListRoles(cookieHeader);
    availableRoles = rolesResult.ok ? rolesResult.data.roles : [];
  }

  const usersResult = await serverListUsers(cookieHeader, {
    includeDeleted: showDeleted,
  });
  if (!usersResult.ok) {
    if (usersResult.status === 401) {
      redirect("/login");
    }
    return <RetryErrorBoundary />;
  }
  const users = usersResult.data.users;
  const liveUsers = users.filter((user) => !user.deletedAt);
  const activeCount = liveUsers.filter(
    (user) => user.status !== "suspended",
  ).length;
  const suspendedCount = liveUsers.filter(
    (user) => user.status === "suspended",
  ).length;
  const rootCount = users.filter((user) => user.isRoot).length;

  return (
    <div className="flex flex-col gap-5">
      <section className="obsidian-panel grid grid-cols-2 divide-y divide-white/[0.06] overflow-hidden sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col justify-between gap-1.5 p-4">
          <span className="text-xs font-medium text-[#8b909a]">
            Total Accounts
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-[#f3f4f6]">
            {users.length}
          </span>
        </div>
        <div className="flex flex-col justify-between gap-1.5 p-4">
          <span className="text-xs font-medium text-[#8b909a]">Active</span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-[#10b981]">
            {activeCount}
          </span>
        </div>
        <div className="flex flex-col justify-between gap-1.5 p-4">
          <span className="text-xs font-medium text-[#8b909a]">Suspended</span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-[#f3f4f6]">
            {suspendedCount}
          </span>
        </div>
        <div className="flex flex-col justify-between gap-1.5 p-4">
          <span className="text-xs font-medium text-[#8b909a]">
            Root Identity
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-[#f3f4f6]">
            {rootCount}
          </span>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold tracking-tight text-[#f3f4f6]">
            Operator Directory
          </h1>
          <span className="obsidian-pill font-mono text-[10px]">
            {users.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-white/[0.08] bg-[#101216] text-xs"
          >
            <Link
              href={showDeleted ? "/users" : "/users?deleted=1"}
              aria-pressed={showDeleted}
            >
              {showDeleted ? "Hide deleted" : "Show deleted"}
            </Link>
          </Button>
          {canCreateUsers ? <AddUserDialog /> : null}
        </div>
      </div>

      {users.length === 0 ? (
        <div className="obsidian-panel p-6 text-center">
          <p className="text-xs text-[#6b707b]">
            {showDeleted ? "No deleted users." : "No users yet."}
          </p>
        </div>
      ) : (
        <>
          <UsersTable
            users={users}
            permissions={permissions}
            availableRoles={availableRoles}
          />
          <UsersStack
            users={users}
            permissions={permissions}
            availableRoles={availableRoles}
          />
        </>
      )}
    </div>
  );
}
