import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AddUserDialog } from "@/components/add-user-dialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

describe("permission-gated action", () => {
  it("renders Add user trigger only when mounted for a users:create holder", () => {
    render(<AddUserDialog />);
    expect(
      screen.getByRole("button", { name: /add user/i }),
    ).toBeInTheDocument();
  });
});
