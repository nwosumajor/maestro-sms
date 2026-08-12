// The client's address, passed on to the API.
//
// The API rate-limits per IP, but the browser never speaks to it — it speaks to
// this web tier, whose proxies forwarded Authorization, x-stepup and
// Content-Type and nothing else. So every request in the world arrived at the
// API from the same peer (the web task) and shared one rate-limit bucket. Six
// password-reset requests from six different client IPs, and the sixth was
// refused; ten sign-in attempts a minute across every school, and the eleventh
// person anywhere was turned away.
//
// nginx (and CloudFront/ALB in cloud) APPENDS the peer it observed to
// `x-forwarded-for`, so the header we receive already ends with the real client
// address. Passing it through verbatim is enough — the API reads the RIGHTMOST
// entry, which is the one a caller cannot forge. See apps/api/src/common/client-ip.ts.

export function forwardedFor(req: { headers: { get(name: string): string | null } } | undefined): Record<string, string> {
  const xff = req?.headers?.get("x-forwarded-for");
  return xff ? { "x-forwarded-for": xff } : {};
}
