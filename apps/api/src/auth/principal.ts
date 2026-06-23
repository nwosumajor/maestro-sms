// Caller identity derived from the verified Auth.js JWT. Mirrors the Principal
// contract the integrity module depends on (integrity.foundation.ts).
export interface Principal {
  userId: string;
  schoolId: string;
  roles: string[];
  permissions: string[];
}
