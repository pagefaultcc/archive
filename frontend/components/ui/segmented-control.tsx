"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SegmentedControlProps = {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string; icon?: ReactNode }[];
  size?: "default" | "sm";
  className?: string;
};

export function SegmentedControl({
  label,
  value,
  onValueChange,
  options,
  size = "default",
  className,
}: SegmentedControlProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-grid max-w-full grid-flow-col auto-cols-fr gap-1 rounded-lg border border-white/[0.06] bg-[#0b0c0e] p-1",
        size === "sm" ? "h-8" : "h-9",
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onValueChange(option.value)}
          className={cn(
            "inline-flex h-full min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/20",
            size === "sm" ? "px-2.5 text-[11px] leading-4" : "px-3 text-xs leading-4",
            value === option.value
              ? "border-white/[0.08] bg-[#16181d] text-[#f3f4f6] shadow-xs"
              : "text-[#8b909a] hover:text-[#e5e7eb]",
          )}
        >
          {option.icon ? (
            <span aria-hidden="true" className="hidden shrink-0 items-center sm:inline-flex [&_svg]:size-3.5">
              {option.icon}
            </span>
          ) : null}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
