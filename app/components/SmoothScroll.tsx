'use client';

import { useEffect, useRef } from 'react';
import Lenis from 'lenis';

export default function SmoothScroll({ children }: { children: React.ReactNode }) {
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    // Someone who asks the OS for less motion should not get an easing
    // curve applied to every wheel tick. Native scrolling for them.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const lenis = new Lenis({
      duration: 1.0,
      lerp: 0.1, // Smooth interpolation (standard for Lenis)
      smoothWheel: true,
      // WITHOUT THIS, NOTHING NESTED CAN SCROLL. Lenis listens for wheel on
      // the window and calls preventDefault() so it can animate the root
      // itself; a wheel over an inner pane — the Kairi transcript, the
      // assistant's message list, the chat sidebar, the mobile nav menu,
      // the admin dropdowns — was swallowed and moved nothing at all.
      // `allowNestedScroll` makes Lenis walk the event path first and stand
      // aside when it crosses an element that can scroll in that direction,
      // so those panes get plain native scrolling (which is also the
      // smoothest thing available: it runs on the compositor). Elements that
      // must always opt out carry `data-lenis-prevent`.
      allowNestedScroll: true,
    });

    lenisRef.current = lenis;

    // Connect Lenis to requestAnimationFrame loop, correctly updating the frame ID
    let rafId: number;
    function raf(time: number) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }

    rafId = requestAnimationFrame(raf);

    // Clean up on unmount
    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  return <>{children}</>;
}

