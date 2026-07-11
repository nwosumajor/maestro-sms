"use client";

// Auto-sliding hero image carousel for the public landing page. Cross-fades
// through several photos on a timer, pauses on hover and honours
// prefers-reduced-motion. Dot controls let a visitor jump between slides.
// Purely presentational — no data, no auth.

import * as React from "react";

export type HeroSlide = { src: string; alt: string };

export function HeroCarousel({
  images,
  intervalMs = 5000,
  className = "",
  showDots = true,
  zoom = true,
}: {
  images: HeroSlide[];
  intervalMs?: number;
  className?: string;
  showDots?: boolean;
  /** Ken Burns slow-zoom. Turn OFF for UI screenshots (zoom would crop them). */
  zoom?: boolean;
}) {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);

  React.useEffect(() => {
    if (paused || images.length < 2) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((v) => (v + 1) % images.length), intervalMs);
    return () => window.clearInterval(id);
  }, [paused, images.length, intervalMs]);

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="group"
      aria-roledescription="carousel"
      aria-label="Life at schools running on the platform"
    >
      {images.map((img, i) => (
        <img
          key={img.src}
          src={img.src}
          alt={i === 0 ? img.alt : ""}
          aria-hidden={i === 0 ? undefined : true}
          width={1600}
          height={1067}
          // First image is the LCP element — eager + high priority; rest lazy.
          loading={i === 0 ? undefined : "lazy"}
          fetchPriority={i === 0 ? "high" : undefined}
          draggable={false}
          // Ken Burns slow-zoom (disabled under reduced-motion); varied origin per slide for gentle pan.
          style={{ transformOrigin: ["center", "top left", "bottom right", "top right", "bottom left"][i % 5] }}
          className={`h-full w-full select-none object-cover transition-opacity duration-1000 ease-in-out ${
            zoom ? "motion-safe:animate-kenburns" : ""
          } ${i === 0 ? "" : "absolute inset-0"} ${i === index ? "opacity-100" : "opacity-0"}`}
        />
      ))}

      {/* subtle bottom gradient so the dots stay legible over bright photos */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/25 to-transparent" />

      {showDots && images.length > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
          {images.map((img, i) => (
            <button
              key={img.src}
              type="button"
              aria-label={`Show slide ${i + 1} of ${images.length}`}
              aria-current={i === index || undefined}
              onClick={() => setIndex(i)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === index ? "w-5 bg-white" : "w-1.5 bg-white/55 hover:bg-white/80"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
