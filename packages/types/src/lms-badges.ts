// =============================================================================
// LMS achievement badges — data-driven catalog (single source of truth)
// =============================================================================
// Badges are POSITIVE recognition a teacher awards to a student (human-in-the-
// loop; never automated, never punitive — see Golden Rule #8). The catalog is a
// fixed constant so both the API (validation) and the web (labels/icons) agree
// without a DB round-trip; adding a badge is a one-line change here.
// =============================================================================

export const LMS_BADGES = [
  { key: "STAR_CONTRIBUTOR", label: "Star Contributor", icon: "⭐", description: "Consistently participates and helps the class." },
  { key: "QUIZ_MASTER", label: "Quiz Master", icon: "🧠", description: "Outstanding quiz performance." },
  { key: "PERFECT_ATTENDANCE", label: "Perfect Attendance", icon: "📅", description: "Never missed a live class." },
  { key: "MOST_IMPROVED", label: "Most Improved", icon: "📈", description: "Great progress over time." },
  { key: "HELPING_HAND", label: "Helping Hand", icon: "🤝", description: "Supports classmates in discussions." },
  { key: "CREATIVE_THINKER", label: "Creative Thinker", icon: "💡", description: "Brings original ideas." },
  { key: "ON_A_ROLL", label: "On a Roll", icon: "🔥", description: "Completed content on a strong streak." },
  { key: "BOOKWORM", label: "Bookworm", icon: "📚", description: "Went above and beyond with the material." },
] as const;

export type LmsBadgeKey = (typeof LMS_BADGES)[number]["key"];

const BADGE_KEYS = new Set<string>(LMS_BADGES.map((b) => b.key));

/** Is `key` a defined badge? Used to validate an award at the API boundary. */
export function isBadgeKey(key: unknown): key is LmsBadgeKey {
  return typeof key === "string" && BADGE_KEYS.has(key);
}

/** Look up a badge's display metadata (icon/label), or a fallback. */
export function badgeMeta(key: string): { key: string; label: string; icon: string; description: string } {
  return LMS_BADGES.find((b) => b.key === key) ?? { key, label: key, icon: "🏅", description: "" };
}
