import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AddUserDialog } from "@/components/add-user-dialog";

describe("permission-gated navigation", () => {
  it("shows Users entry only with users:read", async () => {
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
      usePathname: () => "/users",
    }));
    const { AppSidebar } = await import("@/components/app-sidebar");
    render(
      <SidebarProvider>
        <AppSidebar canReadUsers={true} />
      </SidebarProvider>,
    );
    expect(screen.getByText("Users")).toBeInTheDocument();
  });

  it("hides Users entry without users:read", async () => {
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
      usePathname: () => "/users",
    }));
    const { AppSidebar } = await import("@/components/app-sidebar");
    render(
      <SidebarProvider>
        <AppSidebar canReadUsers={false} />
      </SidebarProvider>,
    );
    expect(screen.queryByText("Users")).not.toBeInTheDocument();
  });
});
