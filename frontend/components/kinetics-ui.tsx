"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export type Icon3DName =
  | "shield"
  | "key"
  | "lock"
  | "notebook"
  | "tools"
  | "target";

const ICON_PATHS: Record<Icon3DName, string> = {
  shield: "/icons/shield-3d.webp",
  key: "/icons/key-3d.webp",
  lock: "/icons/lock-3d.webp",
  notebook: "/icons/notebook-3d.webp",
  tools: "/icons/tools-3d.webp",
  target: "/icons/target-3d.webp",
};

const SIZES = {
  xs: { box: "size-6 rounded-[6px] p-0.5", px: 20 },
  sm: { box: "size-8 rounded-[6px] p-1", px: 24 },
  md: { box: "size-10 rounded-[8px] p-1.5", px: 32 },
  lg: { box: "size-12 rounded-[10px] p-1.5", px: 40 },
} as const;

export function Icon3D({
  name,
  size = "md",
  alt = "",
  className,
}: {
  name: Icon3DName;
  size?: keyof typeof SIZES;
  alt?: string;
  className?: string;
}) {
  const spec = SIZES[size];
  return (
    <span
      aria-hidden={alt === "" ? true : undefined}
      className={cn(
        "kinetics-icon-tile inline-flex shrink-0 items-center justify-center border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]",
        spec.box,
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- local static 3dicons.co WebP asset */}
      <img
        src={ICON_PATHS[name]}
        alt={alt}
        width={spec.px}
        height={spec.px}
        className="kinetics-icon-float size-full object-contain select-none"
      />
    </span>
  );
}

/**
 * Kinetics Magnetic pull wrapper (https://kinetics.colorion.co/ — magnet(0.32)).
 * Pulls the child element toward the cursor inside its bounding box and springs
 * back with cubic-bezier(0.34, 1.56, 0.64, 1) on mouseleave.
 */
export function Magnetic({
  children,
  strength = 0.28,
  className,
}: {
  children: React.ReactNode;
  strength?: number;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);

  function handleMove(event: React.MouseEvent<HTMLDivElement>) {
    if (reducedMotion || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) * strength;
    const dy = (event.clientY - (rect.top + rect.height / 2)) * strength;
    ref.current.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
  }

  function handleLeave() {
    if (!ref.current) return;
    ref.current.style.transform = "translate3d(0px, 0px, 0)";
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className={cn("kinetics-magnetic", className)}
    >
      {children}
    </div>
  );
}

/**
 * Kinetics Spring Number Counter (https://kinetics.colorion.co/ — spring(280, 18)).
 * Bumps elastically on mount and when clicked or when its value changes.
 */
export function SpringCounter({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [bump, setBump] = useState(false);

  useEffect(() => {
    if (reducedMotion) return;
    const frame = window.requestAnimationFrame(() => {
      setBump(true);
    });
    const timer = window.setTimeout(() => setBump(false), 420);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [value, reducedMotion]);

  return (
    <span
      onClick={() => {
        if (reducedMotion) return;
        setBump(false);
        window.requestAnimationFrame(() => {
          setBump(true);
          window.setTimeout(() => setBump(false), 420);
        });
      }}
      className={cn(
        "kinetics-counter inline-block cursor-default tabular-nums select-none",
        bump && "kinetics-counter-bump",
        className,
      )}
    >
      {value}
    </span>
  );
}
