// =============================================================================
// Shared response DTOs — single source of truth for API response SHAPES.
// =============================================================================
// These describe what the API returns over the wire (JSON), so Date fields are
// `string` (ISO). The web consumes them via apiGet<Dto>, replacing the ~40
// per-page interfaces that previously redeclared these shapes. One definition,
// imported everywhere, so a shape change is made (and reviewed) in one place.
//
// DTOs are SERVER-form: Date fields are `Date`, matching what the typed backend
// (TenantTx = Prisma.TransactionClient) actually returns. Backend controllers
// annotate their return types with these DTOs, so a service that stops producing
// a field — or produces the wrong type — fails the build. The web consumes the
// JSON wire shape via `Serialized<Dto>`, where every Date has become an ISO
// string. One definition; the producer and both views are kept in lock-step.
// =============================================================================

/** Maps a server DTO to its JSON wire shape: every Date becomes a string. */
export type Serialized<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Serialized<U>>
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

/** The ubiquitous picker/option row (was `Student`, `ClassRow`, `Room`, `Named`). */
export interface IdNameDto {
  id: string;
  name: string;
}

/** A user summary used by pickers (announcement recipients, message contacts). */
export interface UserSummaryDto extends IdNameDto {
  roles: string[];
}

/** A user summary that also carries the email (role management). */
export interface UserWithEmailDto extends UserSummaryDto {
  email: string;
}
