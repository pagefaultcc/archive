import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "@/components/login-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

let reducedMotion = false;
vi.mock("@/hooks/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: () => reducedMotion,
}));

const beamProps = vi.hoisted(() => ({ latest: null as Record<string, unknown> | null }));
vi.mock("border-beam", () => ({
  BorderBeam: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    beamProps.latest = props;
    return <div data-testid="border-beam">{props.children}</div>;
  },
}));

describe("LoginForm BorderBeam reduced motion", () => {
  it("passes active={false} when reduced motion is requested", () => {
    reducedMotion = true;
    render(<LoginForm />);
    expect(beamProps.latest).not.toBeNull();
    expect(beamProps.latest?.active).toBe(false);
    expect(screen.getByRole("heading", { name: "Archive" })).toBeInTheDocument();
  });

  it("keeps the beam active by default", () => {
    reducedMotion = false;
    render(<LoginForm />);
    expect(beamProps.latest?.active).toBe(true);
  });
});
