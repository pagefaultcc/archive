import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CardsSearch } from "@/components/cards-search";
import { CardSection } from "@/components/ui/card";
import { browserSearchCards } from "@/lib/api";
import type * as ApiModule from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    browserSearchCards: vi.fn(),
    browserReindexCards: vi.fn().mockResolvedValue({ ok: true, data: { status: "started", message: "ok" } }),
  };
});

const mockedSearchCards = vi.mocked(browserSearchCards);

describe("CardsSearch", () => {
  it("renders search bar, performs search, and displays cards with mask/reveal toggle", async () => {
    mockedSearchCards.mockResolvedValue({
      ok: true,
      data: {
        results: [
          {
            id: 1,
            archiveId: "arch-1",
            archiveFilename: "stealer_dump.zip",
            entryPath: "CreditCards/Cards.txt",
            entryName: "Cards.txt",
            holder: "Alice Cooper",
            number: "4111222233334444",
            expMonth: "12",
            expYear: "2026",
            cvv: "123",
            brand: "Visa",
          },
        ],
        totalCount: 1,
        limit: 200,
        offset: 0,
        hasMore: false,
      },
    });

    render(<CardsSearch />);

    await waitFor(() => {
      expect(screen.getByText("Alice Cooper")).toBeInTheDocument();
    });

    expect(screen.getByText("Visa")).toBeInTheDocument();
    expect(screen.getByText("12/26")).toBeInTheDocument();
    // Initially masked
    expect(screen.getByText("•••• •••• •••• 4444")).toBeInTheDocument();

    // Toggle reveal
    const revealBtn = screen.getByRole("button", { name: /reveal numbers/i });
    await userEvent.click(revealBtn);

    expect(screen.getByText("4111 2222 3333 4444")).toBeInTheDocument();

    // Checks telemetry ribbon
    expect(screen.getByText("Total Vault Cards")).toBeInTheDocument();
    expect(screen.getByText("Matching Filter")).toBeInTheDocument();

    // Clicks BIN preset chip
    const binBtn = screen.getByRole("button", { name: /BIN 515462/i });
    await userEvent.click(binBtn);
    expect(mockedSearchCards).toHaveBeenCalledWith(
      expect.objectContaining({ q: "515462" }),
      expect.anything(),
    );

    // Clicks Reindex button in command bar
    const reindexBtn = screen.getByRole("button", { name: /reindex cards across vault/i });
    await userEvent.click(reindexBtn);
  });
  it("renders CardSection primitive with data-slot", () => {
    render(<CardSection className="custom-section">Section Content</CardSection>);
    const section = screen.getByText("Section Content");
    expect(section).toHaveAttribute("data-slot", "card-section");
    expect(section).toHaveClass("custom-section");
  });
});
