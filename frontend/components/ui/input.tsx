import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2 text-[13.5px] font-normal text-[#f7f8f8] shadow-[0_0_0_1px_rgba(0,0,0,0.2)] transition-colors outline-none placeholder:text-[#8a8f98]/60 focus:border-[rgba(255,255,255,0.15)] focus:bg-[rgba(255,255,255,0.04)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
