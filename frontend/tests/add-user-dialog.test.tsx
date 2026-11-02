import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddUserDialog } from "@/components/add-user-dialog";
import { LoginForm } from "@/components/login-form";
import { browserCreateUser } from "@/lib/api";
import { toast } from "sonner";

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

vi.mock("border-beam", () => ({
  BorderBeam: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="border-beam">{children}</div>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, browserCreateUser: vi.fn() };
});

const mockedCreate = vi.mocked(browserCreateUser);
const mockedToast = vi.mocked(toast.success);

describe("AddUserDialog", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    mockedToast.mockClear();
  });

  it("shows inline mismatch error and retains values without calling API", async () => {
    const user = userEvent.setup();
    render(<AddUserDialog />);

    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(screen.getByLabelText("Username"), "operator_1");
    await user.type(screen.getByLabelText("Password", { selector: "#create-password" }), "ArchiveUser!2026");
    await user.type(screen.getByLabelText("Confirm password"), "different-value");
    await user.click(screen.getByRole("button", { name: /create user/i }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Username")).toHaveValue("operator_1");
  });

  it("maps API field errors to controls and retains values", async () => {
    const user = userEvent.setup();
    mockedCreate.mockResolvedValue({
      ok: false,
      status: 400,
      error: {
        code: "invalid_request",
        message: "Check the submitted fields.",
        fields: { username: "Use 3 to 64 letters, numbers, dots, underscores, or hyphens." },
      },
    });
    render(<AddUserDialog />);

    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(screen.getByLabelText("Username"), "bad name!");
    await user.type(screen.getByLabelText("Password", { selector: "#create-password" }), "ArchiveUser!2026");
    await user.type(screen.getByLabelText("Confirm password"), "ArchiveUser!2026");
    await user.click(screen.getByRole("button", { name: /create user/i }));

    expect(
      await screen.findByText("Use 3 to 64 letters, numbers, dots, underscores, or hyphens."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("bad name!");
  });

  it("puts general errors in an aria-live alert and retains values", async () => {
    const user = userEvent.setup();
    mockedCreate.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: "username_taken", message: "That username is already in use." },
    });
    render(<AddUserDialog />);

    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password", { selector: "#create-password" }), "ArchiveUser!2026");
    await user.type(screen.getByLabelText("Confirm password"), "ArchiveUser!2026");
    await user.click(screen.getByRole("button", { name: /create user/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "polite");
    expect(alert).toHaveTextContent("That username is already in use.");
    expect(screen.getByLabelText("Username")).toHaveValue("admin");
    expect(mockedToast).not.toHaveBeenCalled();
  });

  it("closes, resets, toasts, and refreshes on 201", async () => {
    const user = userEvent.setup();
    mockedCreate.mockResolvedValue({
      ok: true,
      data: {
        user: {
          id: "u1",
          username: "operator_1",
          isRoot: false,
          roles: ["user"],
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
    });
    render(<AddUserDialog />);

    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(screen.getByLabelText("Username"), "operator_1");
    await user.type(screen.getByLabelText("Password", { selector: "#create-password" }), "ArchiveUser!2026");
    await user.type(screen.getByLabelText("Confirm password"), "ArchiveUser!2026");
    await user.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => {
      expect(mockedToast).toHaveBeenCalledWith("User created.");
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(mockedCreate).toHaveBeenCalledWith({
      username: "operator_1",
      password: "ArchiveUser!2026",
    });
  });
});

describe("LoginForm invalid credentials", () => {
  it("renders generic invalid-credentials error in aria-live alert and retains username", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "invalid_credentials", message: "Invalid username or password." },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "polite");
    expect(alert).toHaveTextContent("Invalid username or password.");
    expect(screen.getByLabelText("Username")).toHaveValue("admin");
    expect(screen.getByLabelText("Password")).toHaveValue("wrong-password");
  });
});
