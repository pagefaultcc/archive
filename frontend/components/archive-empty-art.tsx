import { Shield } from "lucide-react";
import { cn } from "@/lib/utils";

const sizes = {
  sm: "size-11",
  md: "size-14",
  lg: "size-16",
} as const;

export function ArchiveShieldArt({
  alt,
  size = "md",
  className,
}: {
  alt?: string;
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <div
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border border-white/15 bg-[#121316] text-white shadow-2xs",
        sizes[size],
        className,
      )}
    >
      <Shield className="size-5 stroke-[1.75] text-white" aria-hidden />
    </div>
  );
}
