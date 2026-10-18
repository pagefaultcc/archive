"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BorderBeam } from "border-beam";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

type MotionSurfaceProps = {
  children: ReactNode;
  className?: string;
  busy?: boolean;
  radius?: number;
};

export function MotionSurface({
  children,
  className,
  busy = false,
  radius = 8,
}: MotionSurfaceProps) {
  const reducedMotion = usePrefersReducedMotion();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const initialSweepStarted = useRef(false);
  const revealTimer = useRef<number | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    setMounted(true);
    setFocused(surface.contains(document.activeElement));
    const updateVisibility = () => {
      setDocumentVisible(!document.hidden);
      if (document.hidden) setHovered(false);
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);

    // jsdom and older browsers have no observer; mounted content stays usable.
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(([entry]) => {
          const visible = entry?.isIntersecting ?? false;
          setInView(visible);
          if (!visible) setHovered(false);
        });
    if (observer) observer.observe(surface);
    else setInView(true);

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      clearTimeout(revealTimer.current);
    };
  }, []);

  const enabled = mounted && documentVisible && inView && !reducedMotion;

  useEffect(() => {
    if (!enabled || busy || initialSweepStarted.current) return;
    initialSweepStarted.current = true;
    setRevealing(true);
    revealTimer.current = window.setTimeout(() => setRevealing(false), 2500);
  }, [enabled, busy]);

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
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      onFocus={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setFocused(true);
        }
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      {children}
    </BorderBeam>
  );
}
