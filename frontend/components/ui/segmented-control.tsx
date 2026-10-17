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
        "inline-grid max-w-full grid-flow-col auto-cols-fr gap-0.5 rounded-full border border-white/[0.08] bg-[#0f1011] p-0.5",
        size === "sm" ? "h-7" : "h-9",
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
            "inline-flex h-full min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-transparent font-medium outline-none transition-none focus-visible:ring-2 focus-visible:ring-[rgba(255,255,255,0.15)]",
            size === "sm" ? "px-2 text-[11px] leading-4" : "px-2 text-xs leading-4 sm:px-3",
            value === option.value
              ? "border-white/[0.1] bg-white/[0.08] text-[#f7f8f8]"
              : "text-[#8a8f98] hover:bg-white/[0.03] hover:text-[#d0d6e0]",
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
