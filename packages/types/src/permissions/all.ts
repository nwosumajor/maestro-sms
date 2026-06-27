// =============================================================================
// Aggregate permission type — the union of every domain's permission values.
// =============================================================================
// Single source of truth for "is this a real permission string?". Used to type
// permission arguments (e.g. the web's hasPermission helper and nav gating) so a
// typo or a renamed-away permission becomes a COMPILE error instead of a silently
// mis-gated UI. The backend already references the per-domain *_PERMISSIONS
// objects directly; this gives the frontend the same safety without importing
// sixteen objects everywhere.
// =============================================================================

import type { AdminPermission } from "./admin";
import type { AdmissionPermission } from "./admissions";
import type { AttendancePermission } from "./attendance";
import type { BillingPermission } from "./billing";
import type { CommunicationPermission } from "./communication";
import type { DocumentPermission } from "./documents";
import type { FeesPermission } from "./fees";
import type { GamePermission } from "./game";
import type { GradebookPermission } from "./gradebook";
import type { HrPermission } from "./hr";
import type { IntegrityPermission } from "./integrity";
import type { LmsPermission } from "./lms";
import type { NotificationPermission } from "./notifications";
import type { OperatorPermission } from "./operator";
import type { PrivacyPermission } from "./privacy";
import type { SecurityPermission } from "./security";
import type { SisPermission } from "./sis";
import type { TimetablePermission } from "./timetable";
import type { WorkflowPermission } from "./workflow";

/** Every permission string the system knows about (union of all domains). */
export type Permission =
  | AdminPermission
  | AdmissionPermission
  | AttendancePermission
  | BillingPermission
  | CommunicationPermission
  | DocumentPermission
  | FeesPermission
  | GamePermission
  | GradebookPermission
  | HrPermission
  | IntegrityPermission
  | LmsPermission
  | NotificationPermission
  | OperatorPermission
  | PrivacyPermission
  | SecurityPermission
  | SisPermission
  | TimetablePermission
  | WorkflowPermission;
