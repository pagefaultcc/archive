"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  KeyRound,
  Lock,
  MoreHorizontal,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiError, PublicUser, RoleItem, SessionInfo } from "@/lib/api";
import {
  browserAssignUserRole,
  browserDeleteUser,
  browserListUserSessions,
  browserRemoveUserRole,
  browserResetPassword,
  browserRestoreUser,
  browserRevokeAllUserSessions,
  browserRevokeUserSession,
  browserSetUserSuspended,
  browserUpdateUsername,
} from "@/lib/api";

const dateParser = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

function isUsernameValid(username: string): boolean {
  return /^[A-Za-z0-9._-]{3,64}$/.test(username);
}

function isPasswordValid(password: string): boolean {
  const bytes = new TextEncoder().encode(password).length;
  return bytes >= 12 && bytes <= 128;
}

function failureMessage(result: { error: ApiError | null }): string {
  return result.error?.message ?? "Something went wrong. Please try again.";
}

type EditUsernameDialogProps = {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function EditUsernameDialog({ user, open, onOpenChange }: EditUsernameDialogProps) {
  const router = useRouter();
  const [username, setUsername] = useState(user.username);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setGeneralError(null);
    if (!isUsernameValid(username)) {
      setFieldError("Use 3 to 64 letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    setPending(true);
    const result = await browserUpdateUsername(user.id, username);
    setPending(false);
    if (!result.ok) {
      setFieldError(result.error?.fields?.username ?? null);
      setGeneralError(failureMessage(result));
      return;
    }
    toast.success("Username updated.");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setUsername(user.username);
          setFieldError(null);
          setGeneralError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit username</DialogTitle>
          <DialogDescription>
            Change the username for {user.username}.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor={`edit-username-${user.id}`}>Username</Label>
            <Input
              id={`edit-username-${user.id}`}
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={fieldError ? true : undefined}
              autoComplete="off"
              required
            />
            {fieldError ? (
              <p className="text-sm text-destructive">{fieldError}</p>
            ) : null}
          </div>
          {generalError ? (
            <div role="alert" aria-live="polite" className="text-sm text-destructive">
              {generalError}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ResetPasswordDialogProps = {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ResetPasswordDialog({ user, open, onOpenChange }: ResetPasswordDialogProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setGeneralError(null);
    if (!isPasswordValid(password)) {
      setFieldError("Use 12 to 128 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setFieldError("Passwords do not match.");
      return;
    }
    setPending(true);
    const result = await browserResetPassword(user.id, password);
    setPending(false);
    if (!result.ok) {
      setFieldError(result.error?.fields?.password ?? null);
      setGeneralError(failureMessage(result));
      return;
    }
    toast.success("Password reset. The user's active sessions were revoked.");
    setPassword("");
    setConfirmPassword("");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPassword("");
          setConfirmPassword("");
          setFieldError(null);
          setGeneralError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.username}. Resetting the password revokes
            the user's active sessions.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor={`reset-password-${user.id}`}>New password</Label>
            <Input
              id={`reset-password-${user.id}`}
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldError ? true : undefined}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`reset-confirm-${user.id}`}>Confirm password</Label>
            <Input
              id={`reset-confirm-${user.id}`}
              name="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              aria-invalid={fieldError ? true : undefined}
              autoComplete="new-password"
              required
            />
            {fieldError ? (
              <p className="text-sm text-destructive">{fieldError}</p>
            ) : null}
          </div>
          {generalError ? (
            <div role="alert" aria-live="polite" className="text-sm text-destructive">
              {generalError}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Resetting…" : "Reset password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ManageRolesDialogProps = {
  user: PublicUser;
  availableRoles: RoleItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ManageRolesDialog({
  user,
  availableRoles,
  open,
  onOpenChange,
}: ManageRolesDialogProps) {
  const router = useRouter();
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [pendingRoleIds, setPendingRoleIds] = useState<string[]>([]);

  async function toggleRole(role: RoleItem, assigned: boolean) {
    setPendingRoleIds((ids) => [...ids, role.id]);
    const result = assigned
      ? await browserRemoveUserRole(user.id, role.id)
      : await browserAssignUserRole(user.id, role.id);
    setPendingRoleIds((ids) => ids.filter((id) => id !== role.id));
    if (!result.ok) {
      setGeneralError(failureMessage(result));
      return;
    }
    toast.success(assigned ? `Removed role ${role.label}.` : `Assigned role ${role.label}.`);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage roles</DialogTitle>
          <DialogDescription>
            Assign or remove roles for {user.username}.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2">
          {availableRoles.map((role) => {
            const assigned = user.roles.includes(role.name);
            const pending = pendingRoleIds.includes(role.id);
            return (
              <li
                key={role.id}
                className="flex items-center justify-between gap-2 rounded border px-3 py-2"
              >
                <div>
                  <p className="font-medium">{role.label}</p>
                  <p className="text-xs text-muted-foreground">{role.name}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={assigned ? "outline" : "default"}
                  disabled={pending}
                  onClick={() => void toggleRole(role, assigned)}
                >
                  {pending ? "Working…" : assigned ? "Remove" : "Assign"}
                </Button>
              </li>
            );
          })}
          {availableRoles.length === 0 ? (
            <li className="text-sm text-muted-foreground">No roles available.</li>
          ) : null}
        </ul>
        {generalError ? (
          <div role="alert" aria-live="polite" className="text-sm text-destructive">
            {generalError}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ActiveSessionsDialogProps = {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ActiveSessionsDialog({ user, open, onOpenChange }: ActiveSessionsDialogProps) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  async function loadSessions() {
    setLoadError(null);
    const result = await browserListUserSessions(user.id);
    if (!result.ok) {
      setLoadError(failureMessage(result));
      setSessions([]);
      return;
    }
    setSessions(result.data.sessions);
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      setSessions(null);
      setGeneralError(null);
      void loadSessions();
    }
    onOpenChange(next);
  }

  async function revoke(sessionId: string) {
    setPendingId(sessionId);
    const result = await browserRevokeUserSession(user.id, sessionId);
    setPendingId(null);
    if (!result.ok) {
      setGeneralError(failureMessage(result));
      return;
    }
    setSessions((current) =>
      current ? current.filter((session) => session.id !== sessionId) : current,
    );
    toast.success("Session revoked.");
    router.refresh();
  }

  async function revokeAll() {
    setRevokingAll(true);
    const result = await browserRevokeAllUserSessions(user.id);
    setRevokingAll(false);
    if (!result.ok) {
      setGeneralError(failureMessage(result));
      return;
    }
    setSessions([]);
    toast.success("All sessions revoked.");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Active sessions</DialogTitle>
          <DialogDescription>
            Sessions currently signed in as {user.username}.
          </DialogDescription>
        </DialogHeader>
        {sessions === null ? (
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        ) : loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          <ul className="grid gap-2">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center justify-between gap-2 rounded border px-3 py-2"
              >
                <div className="min-w-0 text-sm">
                  <p className="truncate font-mono text-xs">{session.id.slice(0, 8)}…</p>
                  <p className="text-xs text-muted-foreground">
                    Created {dateParser.format(new Date(session.createdAt))} UTC · Expires{" "}
                    {dateParser.format(new Date(session.expiresAt))} UTC
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pendingId === session.id}
                  onClick={() => void revoke(session.id)}
                >
                  {pendingId === session.id ? "Revoking…" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {generalError ? (
          <div role="alert" aria-live="polite" className="text-sm text-destructive">
            {generalError}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={revokingAll || sessions === null || sessions.length === 0}
            onClick={() => void revokeAll()}
          >
            {revokingAll ? "Revoking…" : "Revoke all sessions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DeleteUserDialogProps = {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function DeleteUserDialog({ user, open, onOpenChange }: DeleteUserDialogProps) {
  const router = useRouter();
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    setPending(true);
    const result = await browserDeleteUser(user.id);
    setPending(false);
    if (!result.ok) {
      setGeneralError(failureMessage(result));
      return;
    }
    toast.success(`User ${user.username} deleted.`);
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete user</DialogTitle>
          <DialogDescription>
            Deleting {user.username} disables their login, revokes their sessions,
            and detaches their roles. The account and audit trail are preserved and
            the user can be restored later.
          </DialogDescription>
        </DialogHeader>
        {generalError ? (
          <div role="alert" aria-live="polite" className="text-sm text-destructive">
            {generalError}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void handleDelete()}
          >
            {pending ? "Deleting…" : "Delete user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type UserRowActionsProps = {
  user: PublicUser;
  permissions: string[];
  availableRoles?: RoleItem[];
};

export function UserRowActions({ user, permissions, availableRoles = [] }: UserRowActionsProps) {
  const router = useRouter();
  const [openDialog, setOpenDialog] = useState<
    "edit" | "password" | "roles" | "sessions" | "delete" | null
  >(null);

  const deleted = Boolean(user.deletedAt);
  const canUpdate = permissions.includes("users:update");
  const canManageRoles = permissions.includes("users:manage_roles");
  const canManageSessions = permissions.includes("users:manage_sessions");
  const canDelete = permissions.includes("users:delete");

  const canEdit = canUpdate && !user.isRoot && !deleted;
  const canSuspend = canUpdate && !user.isRoot && !deleted;
  const canRestore = canDelete && deleted;
  const canDeleteLive = canDelete && !user.isRoot && !deleted;
  const hasMenu =
    canEdit || canSuspend || canManageRoles || canManageSessions || canRestore || canDeleteLive;

  function closeDialog() {
    setOpenDialog(null);
  }

  async function toggleSuspension() {
    const suspending = user.status !== "suspended";
    const result = await browserSetUserSuspended(user.id, suspending);
    if (!result.ok) {
      toast.error(failureMessage(result));
      return;
    }
    toast.success(suspending ? "User suspended." : "User reactivated.");
    router.refresh();
  }

  async function restore() {
    const result = await browserRestoreUser(user.id);
    if (!result.ok) {
      toast.error(failureMessage(result));
      return;
    }
    toast.success(`User ${user.username} restored.`);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {user.isRoot ? (
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          title="The root account cannot be edited, suspended, password-reset, or deleted."
        >
          <Lock className="size-3.5" aria-hidden />
          Immutable root
        </span>
      ) : !hasMenu ? null : (
        <>
          {canManageRoles ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="hidden md:inline-flex"
              onClick={() => setOpenDialog("roles")}
            >
              Roles
            </Button>
          ) : null}
          {canManageSessions ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="hidden md:inline-flex"
              onClick={() => setOpenDialog("sessions")}
            >
              Sessions
            </Button>
          ) : null}
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              aria-label={`Actions for ${user.username}`}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canEdit ? (
              <DropdownMenuItem onSelect={() => setOpenDialog("edit")}>
                <UserCog className="size-4" aria-hidden />
                Edit
              </DropdownMenuItem>
            ) : null}
            {canEdit ? (
              <DropdownMenuItem onSelect={() => setOpenDialog("password")}>
                <KeyRound className="size-4" aria-hidden />
                Reset password
              </DropdownMenuItem>
            ) : null}
            {canSuspend ? (
              <DropdownMenuItem onSelect={() => void toggleSuspension()}>
                {user.status === "suspended" ? (
                  <>
                    <ShieldCheck className="size-4" aria-hidden />
                    Reactivate user
                  </>
                ) : (
                  <>
                    <UserCog className="size-4" aria-hidden />
                    Suspend user
                  </>
                )}
              </DropdownMenuItem>
            ) : null}
            {canManageRoles ? (
              <DropdownMenuItem onSelect={() => setOpenDialog("roles")}>
                Manage roles
              </DropdownMenuItem>
            ) : null}
            {canManageSessions ? (
              <DropdownMenuItem onSelect={() => setOpenDialog("sessions")}>
                Active sessions
              </DropdownMenuItem>
            ) : null}
            {canRestore ? (
              <DropdownMenuItem onSelect={() => void restore()}>
                <RotateCcw className="size-4" aria-hidden />
                Restore user
              </DropdownMenuItem>
            ) : null}
            {canDeleteLive ? (
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => setOpenDialog("delete")}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
      )}

      <EditUsernameDialog
        user={user}
        open={openDialog === "edit"}
        onOpenChange={(open) => (open ? setOpenDialog("edit") : closeDialog())}
      />
      <ResetPasswordDialog
        user={user}
        open={openDialog === "password"}
        onOpenChange={(open) => (open ? setOpenDialog("password") : closeDialog())}
      />
      {canManageRoles ? (
        <ManageRolesDialog
          user={user}
          availableRoles={availableRoles}
          open={openDialog === "roles"}
          onOpenChange={(open) => (open ? setOpenDialog("roles") : closeDialog())}
        />
      ) : null}
      <ActiveSessionsDialog
        user={user}
        open={openDialog === "sessions"}
        onOpenChange={(open) => (open ? setOpenDialog("sessions") : closeDialog())}
      />
      <DeleteUserDialog
        user={user}
        open={openDialog === "delete"}
        onOpenChange={(open) => (open ? setOpenDialog("delete") : closeDialog())}
      />
    </span>
  );
}
