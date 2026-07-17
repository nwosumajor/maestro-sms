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
import type { AlumniPermission } from "./alumni";
import type { FormPermission } from "./form";
import type { AnnouncementPermission } from "./announcements";
import type { AttendancePermission } from "./attendance";
import type { BillingPermission } from "./billing";
import type { CertificatePermission } from "./certificate";
import type { CbtPermission } from "./cbt";
import type { CommunicationPermission } from "./communication";
import type { DisciplinePermission } from "./discipline";
import type { DiscussionPermission } from "./discussion";
import type { DocumentPermission } from "./documents";
import type { FeesPermission } from "./fees";
import type { GamePermission } from "./game";
import type { GradebookPermission } from "./gradebook";
import type { HostelPermission } from "./hostel";
import type { HrPermission } from "./hr";
import type { IntegrityPermission } from "./integrity";
import type { LibraryPermission } from "./library";
import type { LmsPermission } from "./lms";
import type { NotificationPermission } from "./notifications";
import type { OperatorPermission } from "./operator";
import type { PollPermission } from "./poll";
import type { PrivacyPermission } from "./privacy";
import type { ScholarshipPermission } from "./scholarship";
import type { SecurityPermission } from "./security";
import type { SisPermission } from "./sis";
import type { TaskPermission } from "./task";
import type { TimetablePermission } from "./timetable";
import type { TransportPermission } from "./transport";
import type { WorkflowPermission } from "./workflow";

/** Every permission string the system knows about (union of all domains). */
export type Permission =
  | AdminPermission
  | AdmissionPermission
  | AlumniPermission
  | FormPermission
  | AnnouncementPermission
  | AttendancePermission
  | BillingPermission
  | CertificatePermission
  | CbtPermission
  | CommunicationPermission
  | DisciplinePermission
  | DiscussionPermission
  | DocumentPermission
  | FeesPermission
  | GamePermission
  | GradebookPermission
  | HostelPermission
  | HrPermission
  | IntegrityPermission
  | LibraryPermission
  | LmsPermission
  | NotificationPermission
  | OperatorPermission
  | PollPermission
  | PrivacyPermission
  | ScholarshipPermission
  | SecurityPermission
  | SisPermission
  | TaskPermission
  | TimetablePermission
  | TransportPermission
  | WorkflowPermission;
