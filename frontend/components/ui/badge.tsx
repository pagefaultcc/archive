import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-[12px] font-[510] leading-[18px] w-fit whitespace-nowrap shrink-0 gap-1 transition-colors overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.05)] text-[#ffffff]",
        secondary:
          "border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.03)] text-[#f7f8f8]",
        destructive:
          "border-[rgba(249,24,128,0.35)] bg-[rgba(249,24,128,0.12)] text-[#ffffff]",
        outline:
          "border-[rgba(255,255,255,0.08)] bg-transparent text-[#d0d6e0]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}
