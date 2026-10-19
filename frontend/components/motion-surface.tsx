"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BorderBeam } from "border-beam";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

type MotionSurfaceProps = {
  children: ReactNode;
  className?: string;
  busy?: boolean;
  radius?: number;
};

const emptySubscribe = () => () => {};

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function getVisibilitySnapshot() {
  return !document.hidden;
}

const getServerVisibilitySnapshot = () => false;

export function MotionSurface({
  children,
  className,
  radius = 8,
}: MotionSurfaceProps) {
  const reducedMotion = usePrefersReducedMotion();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const documentVisible = useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getServerVisibilitySnapshot,
  );
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry?.isIntersecting ?? false);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const enabled = mounted && documentVisible && inView && !reducedMotion;
  const running = false;
  const pulse = false;

  return (
    <BorderBeam
      ref={surfaceRef}
      size={pulse ? "pulse-inner" : "line"}
      colorVariant="mono"
      theme="dark"
      strength={0}
      duration={2.5}
      borderRadius={radius}
      active={running}
      className={cn("motion-surface w-full", className)}
      style={{ display: "block", overflow: "visible" }}
      data-motion-enabled={enabled}
      data-motion-running={running}
    >
      {children}
    </BorderBeam>
  );
}
