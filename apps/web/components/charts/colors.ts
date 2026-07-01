// Chart palette — a PLAIN module (no "use client"), so both server pages and the
// client Recharts panels can import these token-derived colours. (A "use client"
// module can't export constants consumed by server components — they'd become
// client-reference proxies.)
export const RC = {
  primary: "hsl(var(--primary))",
  primarySoft: "hsl(var(--primary) / 0.55)",
  primaryFaint: "hsl(var(--primary) / 0.3)",
  amber: "hsl(38 92% 50%)",
  red: "hsl(var(--destructive))",
  muted: "hsl(var(--muted-foreground) / 0.4)",
  grid: "hsl(var(--border))",
  axis: "hsl(var(--muted-foreground))",
} as const;
