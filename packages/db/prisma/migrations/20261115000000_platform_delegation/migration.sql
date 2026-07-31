-- =============================================================================
-- platform_delegation — the owner lends a duty to a platform manager, temporarily
-- =============================================================================
-- Top-down delegation, deliberately separate from privilege_grant (which is
-- bottom-up: a holder requests, a peer approves — and is closed to every
-- platform.* permission for exactly that reason).
--
-- No escalation is possible here by construction: the grantor is the platform
-- owner, who already holds everything they can give away. Only the delegable
-- subset may be lent, checked when the row is written AND when it is used.
--
-- Tenant-scoped to the PLATFORM org so ordinary RLS covers it (prisma/rls/99);
-- no bespoke global posture, no deny-all special case.
--
-- Guarded throughout so re-running is a no-op: a failed migration blocks every
-- later one and takes the API down on boot (PR #21).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "platform_delegation" (
    "id"          UUID NOT NULL,
    "schoolId"    UUID NOT NULL,
    "userId"      UUID NOT NULL,
    "permission"  TEXT NOT NULL,
    "reason"      TEXT NOT NULL,
    "grantedById" UUID NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "revokedAt"   TIMESTAMP(3),
    "revokedById" UUID,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_delegation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "platform_delegation_schoolId_idx"
  ON "platform_delegation"("schoolId");
-- The guard's hot path: is there a live grant of THIS permission for THIS user.
CREATE INDEX IF NOT EXISTS "platform_delegation_schoolId_userId_permission_idx"
  ON "platform_delegation"("schoolId", "userId", "permission");

DO $$
BEGIN
  -- RESTRICT to school (Golden Rule #1, the convention all tenant tables share).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_delegation_schoolId_fkey') THEN
    ALTER TABLE "platform_delegation" ADD CONSTRAINT "platform_delegation_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- The three user references follow the documented "scalar column + DB FK, no
  -- Prisma relation" pattern that keeps the User model lean. RESTRICT: a
  -- delegation is a record of who could do what, and deleting the person must not
  -- quietly erase it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_delegation_userId_fkey') THEN
    ALTER TABLE "platform_delegation" ADD CONSTRAINT "platform_delegation_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_delegation_grantedById_fkey') THEN
    ALTER TABLE "platform_delegation" ADD CONSTRAINT "platform_delegation_grantedById_fkey"
      FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_delegation_revokedById_fkey') THEN
    ALTER TABLE "platform_delegation" ADD CONSTRAINT "platform_delegation_revokedById_fkey"
      FOREIGN KEY ("revokedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
