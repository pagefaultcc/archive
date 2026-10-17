import { useState, type FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl } from "@/components/ui/segmented-control";

const options = [
  { value: "files", label: "Files" },
  { value: "passwords", label: "Passwords" },
];

function ControlledSelector({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("files");
  return (
    <SegmentedControl
      label="Search mode"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      options={options}
    />
  );
}

describe("SegmentedControl interactions", () => {
  it("reports the option value and exposes the updated pressed state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledSelector onChange={onChange} />);
    const group = within(screen.getByRole("group", { name: "Search mode" }));
    const files = group.getByRole("button", { name: "Files", pressed: true });
    const passwords = group.getByRole("button", { name: "Passwords", pressed: false });

    await user.click(passwords);

    expect(onChange).toHaveBeenCalledExactlyOnceWith("passwords");
    expect(passwords).toHaveAttribute("aria-pressed", "true");
    expect(files).toHaveAttribute("aria-pressed", "false");
  });

  it("retains native Tab, Enter, and Space activation without submitting its form", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ControlledSelector onChange={onChange} />
      </form>,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "Files" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Passwords" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("passwords");
    expect(screen.getByRole("button", { name: "Passwords", pressed: true })).toHaveFocus();

    await user.tab({ shift: true });
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("files");
    expect(screen.getByRole("button", { name: "Files", pressed: true })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Passwords" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
