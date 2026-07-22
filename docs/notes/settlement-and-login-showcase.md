# Settlement & login showcase

> Paystack split settlement (per-school subaccount, fees → school's own bank, bearer=subaccount) + full-image login panel with image-derived text palettes; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Two builds (user-requested):
- **Fee settlement (Paystack split)**: `school` gained paystackSubaccountCode /
  settlementBankCode / settlementBankName / settlementAccountLast4 (migration
  `20260713030000_school_settlement`; full account numbers NEVER stored).
  `PaystackService.createSubaccount` (percentage_charge =
  PLATFORM_FEES_COMMISSION_PERCENT env, default 0 = school keeps everything) and
  `initialize` gained `subaccount`/`bearer`. `GET/PUT /fees/settlement`
  (fee.manage; PUT step-up + audited; school is GLOBAL so the write uses the
  PRIVILEGED client; NUBAN regex ^\d{10}$). `initInvoicePayment` stamps the
  school's subaccount + `bearer:"subaccount"` (school bears gateway fees on its
  own collections); unset code ⇒ legacy platform settlement. Web:
  `SettlementAccountCard` on /fees/reports (bank picker of 10 NG bank codes +
  NUBAN input). Platform SUBSCRIPTION checkout intentionally has NO subaccount
  (that money is the platform's). Fee-bearer summary: fees w/ split → school
  bears Paystack charge; subscriptions → platform bears Paystack/Stripe fees
  (deducted before settlement/payout).
- **Login showcase**: `LoginShowcase` client component replaces the bg-primary
  aside entirely — full-bleed cross-fading photos (hero-1..4 + band-community)
  with per-slide TEXT ACCENTS derived from each image's dominant hue via PIL
  offline (amber #f3d9ae, blue #aec8f3, peach #f3c8ae, sky #aed9f3, periwinkle
  #aeb7f3); accents recolour eyebrow/stats/margin-rule in sync; scrim keeps
  copy legible; reduced-motion + hover-pause honoured.
Verified live: GET settlement unconfigured shape; PUT → 503 (no Paystack key) /
400 bad NUBAN / 403 teacher; login page has zero bg-primary aside + images
present; smoke 70×2 green. Live subaccount creation needs PAYSTACK_SECRET_KEY.
UNCOMMITTED.

**Edge-seam fix (2026-07-14)**: user saw a thin line on the photo panel's RIGHT
+ BOTTOM. Cause: panel is fractional-width (grid `1.05fr 1fr`), so an
exactly-fitted `object-cover` photo rasterizes ~1px short → panel bg shows as a
hairline seam. Fix in `LoginShowcase`: photos keep `inset-0 h-full w-full
object-cover` + `scale-[1.006]` (bleeds ~2.8px past all four edges; imperceptible
zoom), scrim div uses `-inset-px`, and the `aside` got `bg-neutral-950` as a
belt-and-suspenders backstop. GOTCHA proven via CDP: an `<img>` is a REPLACED
element — `absolute -inset-px` (all four insets, no explicit w/h) makes it fall
back to INTRINSIC ASPECT RATIO (949×633 letterbox), NOT fill; you must keep
explicit `h-full w-full` (or calc) to fill. Also removed the now-unused
`initial` prop/computation. Verified in Chrome both themes: img bleeds -2.8→
+2.9px past panel on all edges. Then user asked to ALSO remove the LEFT
decorative margin-rule (`left-8 w-px` accent line) — DELETED (its `accent` var
stays; still used by eyebrow + stat figures), then the stat-row `border-t
border-white/20` divider too. Now zero rules in the aside (CDP-confirmed).
UNCOMMITTED.

**Dark sign-in half enrichment (2026-07-14)**: user found the RIGHT panel too
plain. Rebuilt `login/page.tsx` `<section>` (still theme-adaptive, token-only)
into a 3-zone flex-col: TOP brand lockup (mark+name, now shown on desktop too,
folds in the old `lg:hidden` mobile mark), CENTER form in a LIFTED CARD
(`rounded-2xl border-border/70 bg-card/70 backdrop-blur-sm shadow-lg` + a
`eyebrow text-primary` "Sign in" kicker), BOTTOM footer (green-dot trust chips
Tenant-isolated/Audit-logged/NDPR-aligned + "Powered by MajorGBN Innovations
Limited" — mirrors homepage). Depth from the design system's OWN devices, both
inset-0 aria-hidden layers: (1) two-tone ambient glow — `radial-gradient` navy
`hsl(var(--primary)/.14)` top-right + logo-green `hsl(var(--accent-2)/.12)`
bottom-left; (2) squared-paper REGISTER grid (30px border-token lines, radial
mask fading out the centre, opacity .5 light / .35 dark). `bg-brand-wash`
replaced. GOTCHA: section uses `isolate` NOT `overflow-hidden` — the inset-0
layers self-bound, and a clip would truncate the card/footer on short mobile
screens. Verified both themes in Chrome: 3 zones render, no h-scroll, card 384px.
UNCOMMITTED.
