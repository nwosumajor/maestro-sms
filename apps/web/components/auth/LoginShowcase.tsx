"use client";

// Full-bleed login identity panel: school-life photography edge to edge (no
// brand colour field at all), with the overlay text taking a per-slide accent
// PALETTE derived from each image's dominant hue (extracted offline with PIL:
// warm amber, blue, peach, sky, periwinkle). The accent recolours the eyebrow,
// stat figures and the margin rule in step with the slideshow; body copy stays
// warm white for legibility over the scrim.

import * as React from "react";

type Slide = { src: string; alt: string; accent: string };

// accent = the image's dominant hue lifted to a readable tint (L≈0.82).
const SLIDES: Slide[] = [
  { src: "/images/hero-1.jpg", alt: "Students in class", accent: "#f3d9ae" },
  { src: "/images/hero-2.jpg", alt: "School community", accent: "#aec8f3" },
  { src: "/images/hero-3.jpg", alt: "Learning together", accent: "#f3c8ae" },
  { src: "/images/hero-4.jpg", alt: "School life", accent: "#aed9f3" },
  { src: "/images/band-community.jpg", alt: "School community event", accent: "#aeb7f3" },
];
const INTERVAL_MS = 6000;

export function LoginShowcase({
  logoUrl,
  schoolName,
}: {
  logoUrl: string | null;
  schoolName: string;
}) {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);

  React.useEffect(() => {
    if (paused) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((v) => (v + 1) % SLIDES.length), INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused]);

  const accent = SLIDES[index].accent;

  return (
    <div
      className="relative flex h-full min-h-screen flex-col justify-between p-12 text-white"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Cross-fading full-bleed photos. */}
      {SLIDES.map((s, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- decorative slideshow
        <img
          key={s.src}
          src={s.src}
          alt={i === index ? s.alt : ""}
          aria-hidden={i !== index}
          // inset-0 + h/w-full fills the panel exactly (an <img> is a replaced
          // element, so it honours the explicit 100%/100%). The panel width/height
          // are fractional (grid fr units), so an exactly-fitted photo can
          // rasterize a hair short and leave a 1px seam at the right/bottom edge;
          // scale-[1.006] bleeds it a couple of px past all edges and the aside's
          // overflow-hidden clips the excess. No visible zoom at this factor.
          className="absolute inset-0 h-full w-full scale-[1.006] object-cover transition-opacity duration-1000"
          style={{ opacity: i === index ? 1 : 0 }}
        />
      ))}
      {/* Legibility scrim — photos stay the star, text stays readable. */}
      <div aria-hidden className="pointer-events-none absolute -inset-px bg-gradient-to-t from-neutral-950/85 via-neutral-950/40 to-neutral-950/25" />

      <div className="relative flex items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote tenant logo
          <img src={logoUrl} alt={`${schoolName} logo`} className="h-11 w-11 rounded-xl bg-white/10 object-contain p-1.5" />
        ) : (
          // Platform default mark until the school uploads its own logo.
          // eslint-disable-next-line @next/next/no-img-element -- static platform asset
          <img src="/images/platform-mark.png" alt="MajorGBN" className="h-11 w-11 rounded-xl bg-white/10 object-contain p-1 ring-1 ring-inset ring-white/20 backdrop-blur-sm" />
        )}
        <span className="text-sm font-semibold tracking-tight drop-shadow">{schoolName}</span>
      </div>

      <div className="relative max-w-md">
        <p className="eyebrow transition-colors duration-1000" style={{ color: accent }}>
          School operations, in one register
        </p>
        <h1 className="mt-3 text-4xl font-semibold leading-[1.1] tracking-tight drop-shadow-sm">
          Every class, fee, and record — kept in order.
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-white/85">
          Attendance, timetables, results, and approvals for your whole school, with the privacy and
          least-privilege controls a school owes its students.
        </p>
      </div>

      <dl className="relative grid grid-cols-3 gap-6 pt-6">
        {[
          ["1 sign-in", "for every role"],
          ["Tenant-isolated", "by design"],
          ["Audit-logged", "end to end"],
        ].map(([stat, label]) => (
          <div key={stat}>
            <dt className="text-sm font-semibold tracking-tight transition-colors duration-1000" style={{ color: accent }}>
              {stat}
            </dt>
            <dd className="mt-0.5 text-xs text-white/70">{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
