import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AddUserDialog } from "@/components/add-user-dialog";
import { Icon3D, SpringCounter } from "@/components/kinetics-ui";
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

function formatTimestamp(value: string): string {
  return `${dateParser.format(new Date(value))} UTC`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function Avatar({ username }: { username: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-white/15 bg-[#0c0c0f] text-[10px] font-medium text-white"
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
    <span className="inline-flex flex-wrap gap-1">
      {roles.map((role) => (
        <Badge key={role} variant="outline">
          {role}
        </Badge>
      ))}
    </span>
  );
}

function AccessDenied() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-6xl font-semibold tracking-tight">403</h1>
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
    <div className="hidden rounded-lg border border-border/70 bg-card md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Roles</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <Avatar username={user.username} />
                  <span className="font-medium">{user.username}</span>
                  {user.isRoot ? <Badge variant="outline">root</Badge> : null}
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortId(user.id)}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge user={user} />
              </TableCell>
              <TableCell>
                <RolePills roles={user.roles} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatTimestamp(user.createdAt)}
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
        <Card key={user.id} className="border-border/70 bg-card">
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex items-center gap-2">
              <Avatar username={user.username} />
              <span className="font-medium">{user.username}</span>
              {user.isRoot ? <Badge variant="outline">root</Badge> : null}
              <StatusBadge user={user} />
            </div>
            <p className="text-sm text-muted-foreground">
              ID: <span className="font-mono">{shortId(user.id)}</span>
            </p>
            <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              Roles: <RolePills roles={user.roles} />
            </div>
            <p className="text-sm text-muted-foreground">
              Created: {formatTimestamp(user.createdAt)}
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-lg font-semibold tracking-tight">
        <SpringCounter value={value} />
      </p>
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
    permissions.includes("roles:read") || permissions.includes("users:manage_roles");
  let availableRoles: RoleItem[] = [];
  if (canListRoles) {
    const rolesResult = await serverListRoles(cookieHeader);
    availableRoles = rolesResult.ok ? rolesResult.data.roles : [];
  }

  const usersResult = await serverListUsers(cookieHeader, { includeDeleted: showDeleted });
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
      <section className="kinetics-card w-full rounded-lg border border-border/70 bg-card p-4">
        <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <Icon3D name="target" size="md" />
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Directory status
              </p>
              <p className="text-sm font-medium">Directory healthy</p>
              <p className="text-xs text-muted-foreground">
                {users.length} account{users.length === 1 ? "" : "s"} loaded
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-border/70 pt-4 sm:grid-cols-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <Metric label="Total accounts" value={users.length} />
            <Metric label="Active" value={activeCount} />
            <Metric label="Suspended" value={suspendedCount} />
            <Metric label="Root identity" value={rootCount} />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold tracking-tight">Users</h1>
          <Badge variant="secondary">{users.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
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
        <div className="rounded-lg border border-border/70 bg-card p-4">
          <p className="text-sm text-muted-foreground">
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
