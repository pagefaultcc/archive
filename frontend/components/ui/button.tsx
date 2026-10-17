import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-[13px] font-[510] leading-[19.5px] whitespace-nowrap transition-[transform,background-color,border-color,color,box-shadow] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.025] active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,255,255,0.15)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[rgba(255,255,255,0.05)] text-[#f7f8f8] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03),inset_0_1px_0_0_rgba(255,255,255,0.04),0_0_0_1px_rgba(0,0,0,0.6),0_4px_4px_0_rgba(0,0,0,0.1)] hover:bg-[rgba(255,255,255,0.08)] hover:text-[#ffffff]",
        destructive:
          "bg-[rgba(249,24,128,0.12)] text-[#ffffff] shadow-[inset_0_0_0_1px_rgba(249,24,128,0.35)] hover:bg-[rgba(249,24,128,0.2)]",
        outline:
          "border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-[#f7f8f8] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.05)] hover:text-[#ffffff]",
        secondary:
          "border border-[rgba(255,255,255,0.05)] bg-[#0f1011] text-[#f7f8f8] hover:bg-[rgba(255,255,255,0.05)]",
        ghost:
          "bg-transparent font-normal text-[#8a8f98] transition-none hover:scale-100 active:scale-100 hover:bg-[rgba(255,255,255,0.05)] hover:text-[#f7f8f8]",
        link: "text-[#f7f8f8] underline-offset-4 transition-none hover:scale-100 active:scale-100 hover:underline",
      },
      size: {
        default: "h-10 px-3.5",
        xs: "h-7 gap-1 px-2.5 text-[12px] transition-none hover:scale-100 active:scale-100",
        sm: "h-8 gap-1.5 px-3 text-[13px]",
        lg: "h-10 px-5",
        icon: "size-10",
        "icon-xs": "size-7",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
