// =============================================================================
// SMS design tokens — cross-platform source of truth
// =============================================================================
// The values here MUST match apps/web/app/globals.css. Web styling is driven by
// the CSS variables; this module exists for non-CSS consumers (charts, emails,
// future React Native via the shared package) and as the human-readable spec.
// Values are HSL channels ("H S% L%") so they drop straight into hsl().
// =============================================================================

/** Primitive neutral ramp (slate). */
export const neutral = {
  0: "0 0% 100%",
  50: "210 20% 98%",
  100: "220 14% 96%",
  200: "220 13% 91%",
  300: "216 12% 84%",
  400: "218 11% 65%",
  500: "220 9% 46%",
  600: "215 14% 34%",
  700: "217 19% 27%",
  800: "215 28% 17%",
  900: "222 47% 11%",
  950: "222 47% 7%",
} as const;

/** Default brand (deep academic teal). Per-tenant theming overrides H/S/L at runtime. */
export const brand = { h: 184, s: 68, l: 31 } as const;

/** Semantic roles for the default (light) theme. */
export const semanticLight = {
  background: neutral[0],
  foreground: neutral[900],
  card: neutral[0],
  cardForeground: neutral[900],
  primary: `${brand.h} ${brand.s}% ${brand.l}%`,
  primaryForeground: neutral[0],
  secondary: neutral[100],
  muted: neutral[100],
  mutedForeground: neutral[500],
  border: neutral[200],
  ring: `${brand.h} ${brand.s}% ${brand.l}%`,
  destructive: "0 72% 51%",
} as const;

/**
 * Integrity severity scale — bg/fg pairs. CONSTANT across tenants and themes by
 * design: "HIGH" must read identically everywhere (Golden Rule #8 — this is a
 * review PRIORITY, never a verdict). Ordered low→high attention.
 */
export const severity = {
  INFO: { bg: "220 14% 96%", fg: "220 39% 30%" },
  LOW: { bg: "48 96% 89%", fg: "28 74% 26%" },
  MEDIUM: { bg: "34 100% 92%", fg: "22 82% 31%" },
  HIGH: { bg: "0 86% 95%", fg: "0 70% 35%" },
} as const;

/** 4px base spacing scale (matches Tailwind's default rem steps). */
export const spacing = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  6: "1.5rem",
  8: "2rem",
  12: "3rem",
  16: "4rem",
} as const;

export const typography = {
  fontSans: '"Inter", ui-sans-serif, system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", monospace',
  size: {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
  },
  weight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  leading: { tight: 1.25, normal: 1.5, relaxed: 1.625 },
} as const;

export const radius = {
  sm: "calc(0.625rem - 4px)",
  md: "calc(0.625rem - 2px)",
  lg: "0.625rem",
  base: "0.625rem",
} as const;

/** A per-tenant brand override (only the brand hue moves). */
export interface TenantTheme {
  h: number;
  s: number;
  l: number;
}

/** Build the CSS-variable style object the web layer puts on the tenant wrapper. */
export function tenantThemeVars(t: TenantTheme): Record<string, string> {
  return {
    "--brand-h": String(t.h),
    "--brand-s": `${t.s}%`,
    "--brand-l": `${t.l}%`,
  };
}

/** Reference presets (also mirrored in globals.css as data-tenant-theme). */
export const TENANT_PRESETS = {
  indigo: { h: 243, s: 75, l: 58 },
  emerald: { h: 160, s: 84, l: 39 },
  rose: { h: 347, s: 77, l: 50 },
} as const satisfies Record<string, TenantTheme>;
