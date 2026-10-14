"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Icon3D, SpringCounter } from "@/components/kinetics-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  browserCreateRole,
  browserDeleteRole,
  browserUpdateRole,
} from "@/lib/api";
import type { PermissionItem, RoleItem } from "@/lib/api";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

type RoleFormValues = {
  name: string;
  label: string;
  permissions: string[];
};

function permissionNamePattern(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function PermissionChecklist({
  permissions,
  selected,
  onToggle,
  idPrefix,
}: {
  permissions: PermissionItem[];
  selected: string[];
  onToggle: (name: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-3">
      {permissions.map((permission) => {
        const inputId = `${idPrefix}-${permission.id}`;
        return (
          <div key={permission.id} className="flex items-center gap-3 py-0.5">
            <input
              id={inputId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={selected.includes(permission.name)}
              onChange={() => onToggle(permission.name)}
            />
            <Label htmlFor={inputId} className="cursor-pointer font-normal">
              <span className="font-mono text-xs">{permission.name}</span>
              <span className="ml-2 text-muted-foreground">{permission.label}</span>
            </Label>
          </div>
        );
      })}
      {permissions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No permissions available.</p>
      ) : null}
    </div>
  );
}

function RoleFields({
  idPrefix,
  values,
  fieldErrors,
  permissions,
  onValueChange,
}: {
  idPrefix: string;
  values: RoleFormValues;
  fieldErrors: Record<string, string>;
  permissions: PermissionItem[];
  onValueChange: (next: RoleFormValues) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          autoComplete="off"
          value={values.name}
          onChange={(event) => onValueChange({ ...values, name: event.target.value })}
          aria-invalid={fieldErrors.name ? true : undefined}
        />
        {fieldErrors.name ? (
          <p className="text-sm text-destructive">{fieldErrors.name}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-label`}>Label</Label>
        <Input
          id={`${idPrefix}-label`}
          autoComplete="off"
          value={values.label}
          onChange={(event) => onValueChange({ ...values, label: event.target.value })}
          aria-invalid={fieldErrors.label ? true : undefined}
        />
        {fieldErrors.label ? (
          <p className="text-sm text-destructive">{fieldErrors.label}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label>Permissions</Label>
        <PermissionChecklist
          permissions={permissions}
          selected={values.permissions}
          onToggle={(name) =>
            onValueChange({
              ...values,
              permissions: values.permissions.includes(name)
                ? values.permissions.filter((value) => value !== name)
                : [...values.permissions, name],
            })
          }
          idPrefix={idPrefix}
        />
      </div>
    </>
  );
}

function validateRoleValues(values: RoleFormValues): Record<string, string> {
  const fields: Record<string, string> = {};
  if (
    values.name.length < 3 ||
    values.name.length > 64 ||
    !permissionNamePattern(values.name)
  ) {
    fields.name = "Use 3 to 64 letters, numbers, dots, underscores, or hyphens.";
  }
  const label = values.label.trim();
  if (label.length === 0 || values.label.length > 128) {
    fields.label = "Enter a display label of 1 to 128 characters.";
  }
  return fields;
}

function RoleMutationDialog({
  mode,
  role,
  permissions,
  trigger,
  onSubmit,
}: {
  mode: "create" | "edit";
  role?: RoleItem;
  permissions: PermissionItem[];
  trigger: React.ReactNode;
  onSubmit: (
    values: { name: string; label: string; permissions: string[] },
  ) => Promise<Record<string, string> | null>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<RoleFormValues>(
    mode === "edit" && role
      ? { name: role.name, label: role.label, permissions: [...role.permissions] }
      : { name: "", label: "", permissions: [] },
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function closeAndReset() {
    setOpen(false);
    setValues(
      mode === "edit" && role
        ? { name: role.name, label: role.label, permissions: [...role.permissions] }
        : { name: "", label: "", permissions: [] },
    );
    setFieldErrors({});
    setGeneralError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const validation = validateRoleValues(values);
    setFieldErrors(validation);
    if (Object.keys(validation).length > 0) {
      return;
    }
    setPending(true);
    setGeneralError(null);
    const errorMap = await onSubmit({
      name: values.name,
      label: values.label,
      permissions: values.permissions,
    });
    setPending(false);
    if (errorMap === null) {
      closeAndReset();
      return;
    }
    const { __general, ...fields } = errorMap;
    if (__general) {
      setGeneralError(__general);
    }
    setFieldErrors(fields);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeAndReset();
        else setOpen(true);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="spring-enter sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">
            {mode === "create" ? "Create role" : "Edit role"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Define a new role and its permissions."
              : "Update the role name, label, and permissions."}
          </DialogDescription>
        </DialogHeader>
        <div className="mb-1 h-px bg-border" role="presentation" />
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <RoleFields
            idPrefix={`role-${mode}`}
            values={values}
            fieldErrors={fieldErrors}
            permissions={permissions}
            onValueChange={(next) => {
              setValues(next);
              setFieldErrors((current) =>
                Object.keys(current).length > 0 ? {} : current,
              );
            }}
          />
          {generalError ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeAndReset}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending} className="spring-interactive">
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {mode === "create" ? "Create role" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RolesManager({
  roles,
  permissions,
  actorPermissions,
}: {
  roles: RoleItem[];
  permissions: PermissionItem[];
  actorPermissions: string[];
}) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<RoleItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canCreate = actorPermissions.includes("roles:create");
  const canUpdate = actorPermissions.includes("roles:update");
  const canDelete = actorPermissions.includes("roles:delete");

  async function runMutation(
    mode: "create" | "edit",
    call: () => Promise<
      | { ok: true }
      | {
          ok: false;
          networkError?: boolean;
          status: number;
          error: { message: string; fields?: Record<string, string> } | null;
        }
    >,
  ): Promise<Record<string, string> | null> {
    const result = await call();
    if (result.ok) {
      toast.success(mode === "create" ? "Role created." : "Role updated.");
      router.refresh();
      return null;
    }
    const general = result.networkError || result.status >= 500
      ? "The service is temporarily unavailable. Try again shortly."
      : result.error?.message ?? "Check the submitted fields.";
    if (result.error?.fields) {
      return { ...result.error.fields, __general: general };
    }
    return { __general: general };
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await browserDeleteRole(deleteTarget.id);
    setDeleting(false);
    if (result.ok) {
      toast.success("Role deleted.");
      setDeleteTarget(null);
      router.refresh();
      return;
    }
    toast.error(result.error?.message ?? "Could not delete the role.");
    setDeleteTarget(null);
  }

  const totalRoles = roles.length;
  const systemProtected = roles.filter((role) => role.protected).length;
  const customRoles = roles.filter((role) => !role.protected).length;
  const catalogPermissions = permissions.length;

  const metrics: Array<{ label: string; value: number }> = [
    { label: "Total roles", value: totalRoles },
    { label: "System protected", value: systemProtected },
    { label: "Custom roles", value: customRoles },
    { label: "Catalog permissions", value: catalogPermissions },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section className="kinetics-card w-full rounded-lg border border-border/70 bg-card p-4">
        <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="flex items-start gap-3">
            <Icon3D name="shield" size="md" />
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold tracking-tight">RBAC policy</h2>
              <span className="text-xs text-muted-foreground">
                Status: Enforced
              </span>
              <p className="text-xs text-muted-foreground">
                Permissions resolve through role membership on every request.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-border/70 pt-4 sm:grid-cols-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex flex-col gap-0.5">
                <span className="text-lg font-semibold tabular-nums tracking-tight">
                  <SpringCounter value={metric.value} />
                </span>
                <span className="text-xs text-muted-foreground">{metric.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-semibold tracking-tight">Roles</h1>
        {canCreate ? (
          <RoleMutationDialog
            mode="create"
            permissions={permissions}
            trigger={
              <Button size="sm" className="spring-interactive">
                <Plus aria-hidden /> Create role
              </Button>
            }
            onSubmit={(values) => runMutation("create", () => browserCreateRole(values))}
          />
        ) : null}
      </div>

      <div className="kinetics-stagger grid gap-4 lg:grid-cols-2">
        {roles.map((role) => (
          <Card key={role.id} data-testid={`role-row-${role.name}`}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div className="flex min-w-0 items-start gap-3">
                <Icon3D name={role.protected ? "lock" : "tools"} size="sm" />
                <div className="min-w-0 space-y-1.5">
                  <CardTitle className="text-sm font-semibold tracking-tight">
                    {role.label}
                  </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {role.name}
                  </Badge>
                  {role.protected ? (
                    <Badge variant="secondary">Immutable system role</Badge>
                  ) : (
                    <Badge variant="outline">Custom role</Badge>
                  )}
                </CardDescription>
                </div>
              </div>
              {canUpdate && !role.protected ? (
                <RoleMutationDialog
                  mode="edit"
                  role={role}
                  permissions={permissions}
                  trigger={
                    <Button variant="outline" size="sm" className="spring-interactive">
                      <Pencil aria-hidden /> Edit role
                    </Button>
                  }
                  onSubmit={(values) =>
                    runMutation("edit", () => browserUpdateRole(role.id, values))
                  }
                />
              ) : null}
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Permissions
              </p>
              <div className="flex flex-wrap gap-1.5">
                {role.permissions.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    No permissions
                  </span>
                ) : (
                  role.permissions.map((permission) => (
                    <Badge
                      key={permission}
                      variant="secondary"
                      className="font-mono text-[11px]"
                    >
                      {permission}
                    </Badge>
                  ))
                )}
              </div>
            </CardContent>
            <CardFooter className="justify-end gap-2 border-t border-border/70 pt-3">
              {canDelete && !role.protected ? (
                <Dialog
                  open={deleteTarget?.id === role.id}
                  onOpenChange={(next) => setDeleteTarget(next ? role : null)}
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="spring-interactive text-destructive"
                    >
                      <Trash2 aria-hidden /> Delete role
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="spring-enter sm:max-w-sm">
                    <DialogHeader>
                      <DialogTitle className="text-base font-semibold tracking-tight">
                        Delete role
                      </DialogTitle>
                      <DialogDescription>
                        Delete the role &quot;{role.label}&quot; ({role.name})? This
                        cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDeleteTarget(null)}
                        disabled={deleting}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={deleting}
                        className="spring-interactive"
                      >
                        {deleting ? (
                          <Loader2 aria-hidden className="animate-spin" />
                        ) : null}
                        Delete role
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              ) : null}
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
