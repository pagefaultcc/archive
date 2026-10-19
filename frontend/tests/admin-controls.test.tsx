import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { UserRowActions } from "@/components/user-row-actions";
import { RolesManager } from "@/components/roles-manager";
import { AuditViewer } from "@/components/audit-viewer";
import {
  browserCreateRole,
  browserListAudit,
  browserSetUserSuspended,
  browserUpdateUsername,
} from "@/lib/api";
import type { AuditEntry, RoleItem } from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    browserUpdateUsername: vi.fn(),
    browserSetUserSuspended: vi.fn(),
    browserDeleteRole: vi.fn(),
    browserCreateRole: vi.fn(),
    browserUpdateRole: vi.fn(),
    browserListAudit: vi.fn(),
  };
});

const mockedUpdateUsername = vi.mocked(browserUpdateUsername);
const mockedSetSuspended = vi.mocked(browserSetUserSuspended);
const mockedListAudit = vi.mocked(browserListAudit);
const mockedCreate = vi.mocked(browserCreateRole);

const baseUser = {
  id: "u-1",
  username: "operator_1",
  isRoot: false,
  roles: ["user"],
  createdAt: "2026-01-01T00:00:00Z",
};

const rootUser = { ...baseUser, id: "u-root", username: "playersclub", isRoot: true };

const customRole: RoleItem = {
  id: "r-1",
  name: "editor",
  label: "Editor",
  protected: false,
  permissions: ["users:read"],
};

const roles: RoleItem[] = [
  customRole,
  {
    id: "r-root",
    name: "root",
    label: "Root",
    protected: true,
    permissions: ["users:read", "users:create"],
  },
  {
    id: "r-user",
    name: "user",
    label: "User",
    protected: true,
    permissions: [],
  },
];

const permissions = [
  { id: "p-read", name: "users:read", label: "Read users" },
  { id: "p-create", name: "roles:create", label: "Create roles" },
];

function openUserMenu(user: UserEvent, username: string) {
  const trigger = screen.getAllByRole("button", { name: new RegExp(username, "i") })
    .find((element) => element.getAttribute("aria-haspopup") === "menu");
  expect(trigger).toBeTruthy();
  return user.click(trigger!);
}

beforeEach(() => {
  mockedUpdateUsername.mockReset();
  mockedSetSuspended.mockReset();
  mockedListAudit.mockReset();
  mockedCreate.mockReset();
});

describe("UserRowActions", () => {
  it("shows Immutable root and no mutation controls for a root user", async () => {
    render(
      <UserRowActions
        user={rootUser}
        permissions={["users:update", "users:delete"]}
        availableRoles={[]}
      />,
    );
    expect(screen.getByText("Immutable root")).toBeInTheDocument();
    // Root renders the lock badge instead of the actions menu entirely.
    expect(screen.queryByRole("button", { name: /actions for/i })).not.toBeInTheDocument();
  });

  it("edits a non-root username via the API", async () => {
    const user = userEvent.setup();
    mockedUpdateUsername.mockResolvedValue({ ok: true, data: { user: {
      id: baseUser.id, username: "renamed", isRoot: false, roles: ["user"],
      createdAt: baseUser.createdAt,
    } } });
    render(
      <UserRowActions user={baseUser} permissions={["users:update"]} availableRoles={[]} />,
    );
    await openUserMenu(user, "operator_1");
    await user.click(screen.getByRole("menuitem", { name: /edit/i }));
    const input = screen.getByLabelText("Username");
    await user.clear(input);
    await user.type(input, "renamed");
    await user.click(screen.getByRole("button", { name: /save|confirm/i }));
    await waitFor(() => expect(mockedUpdateUsername).toHaveBeenCalledWith("u-1", "renamed"));
  });

  it("suspends an active non-root user via the API", async () => {
    const user = userEvent.setup();
    mockedSetSuspended.mockResolvedValue({ ok: true, data: { user: baseUser } });
    render(
      <UserRowActions user={baseUser} permissions={["users:update"]} availableRoles={[]} />,
    );
    await openUserMenu(user, "operator_1");
    await user.click(screen.getByRole("menuitem", { name: /suspend/i }));
    await waitFor(() =>
      expect(mockedSetSuspended).toHaveBeenCalledWith("u-1", true),
    );
  });
});

describe("RolesManager", () => {
  it("disables edit and delete for protected system roles", () => {
    render(
      <RolesManager
        roles={roles}
        permissions={permissions}
        actorPermissions={["roles:update", "roles:delete"]}
      />,
    );
    expect(screen.getAllByText("Immutable system role")).toHaveLength(2);
    // Only the custom (unprotected) role exposes edit/delete triggers.
    expect(screen.getAllByRole("button", { name: /edit role/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /delete role/i })).toHaveLength(1);
  });

  it("creates a custom role when roles:create is present", async () => {
    mockedCreate.mockReset();
    mockedCreate.mockResolvedValue({ ok: true, data: { role: customRole } });
    const user = userEvent.setup();
    render(
      <RolesManager
        roles={roles}
        permissions={permissions}
        actorPermissions={["roles:create"]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /create role/i }));
    await user.type(screen.getByLabelText("Name"), "auditor");
    await user.type(screen.getByLabelText("Label"), "Auditor");
    await user.click(screen.getByRole("button", { name: /^create role$/i }));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        name: "auditor",
        label: "Auditor",
        permissions: [],
      }),
    );
  });
});

const auditEntries: AuditEntry[] = [
  {
    id: 1,
    actorId: "u-root",
    action: "user.created",
    targetType: "user",
    targetId: "u-1",
    metadata: { username: "operator_1" },
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    actorId: "u-root",
    action: "role.deleted",
    targetType: "role",
    targetId: "r-9",
    metadata: {},
    createdAt: "2026-01-02T00:00:00Z",
  },
];

describe("AuditViewer", () => {
  it("renders initial entries with timestamps, targets, and metadata", () => {
    render(
      <AuditViewer
        initialPage={{ entries: auditEntries, nextCursor: null, hasMore: false }}
      />,
    );
    expect(screen.getByText("user:u-1")).toBeInTheDocument();
    expect(screen.getAllByText(/username="operator_1"/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Jan 1, 2026/).length).toBeGreaterThanOrEqual(1);
    // Entry badges plus the filter option both mention actions; count table badge.
    expect(screen.getAllByText("user.created").length).toBeGreaterThanOrEqual(2);
  });

  it("filters by action via browserListAudit", async () => {
    mockedListAudit.mockResolvedValue({
      ok: true,
      data: { entries: [auditEntries[1]], nextCursor: null, hasMore: false },
    });
    const user = userEvent.setup();
    render(
      <AuditViewer
        initialPage={{ entries: auditEntries, nextCursor: null, hasMore: false }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "role.deleted" },
    });
    await user.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() =>
      expect(mockedListAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "role.deleted", limit: 25 }),
      ),
    );
    const rows = await screen.findAllByText("role.deleted");
    expect(rows.length).toBeGreaterThanOrEqual(2); // filter <option> plus entry badge(s)
  });
});
