// =============================================================================
// ALL_PERMISSIONS — the RUNTIME list, beside the compile-time union
// =============================================================================
// `Permission` (in ./all) is a TYPE, so nothing could render a list of what a
// school may ask for: the elevation form shipped a free-text box where somebody
// typed `fee.mange` and got a request that could only ever be refused. A type
// cannot populate a dropdown; this can.
//
// DERIVED, never hand-listed — every domain's own constant object is the source,
// so a permission added to a domain appears here without anyone remembering.
// `every-permission-is-offerable.spec` fails if a domain object exists that this
// file does not aggregate.
// =============================================================================

import { ADMIN_PERMISSIONS } from "./admin";
import { ADMISSION_PERMISSIONS } from "./admissions";
import { ALUMNI_PERMISSIONS } from "./alumni";
import { ANNOUNCEMENT_PERMISSIONS } from "./announcements";
import { ATTENDANCE_PERMISSIONS } from "./attendance";
import { BILLING_PERMISSIONS } from "./billing";
import { CBT_PERMISSIONS } from "./cbt";
import { CERTIFICATE_PERMISSIONS } from "./certificate";
import { COMMUNICATION_PERMISSIONS } from "./communication";
import { DISCIPLINE_PERMISSIONS } from "./discipline";
import { DISCUSSION_PERMISSIONS } from "./discussion";
import { DOCUMENT_PERMISSIONS } from "./documents";
import { EXAM_PERMISSIONS } from "./exam";
import { FEES_PERMISSIONS } from "./fees";
import { FORM_PERMISSIONS } from "./form";
import { GAME_PERMISSIONS } from "./game";
import { GRADEBOOK_PERMISSIONS } from "./gradebook";
import { HOSTEL_PERMISSIONS } from "./hostel";
import { HR_PERMISSIONS } from "./hr";
import { INTEGRITY_PERMISSIONS } from "./integrity";
import { LIBRARY_PERMISSIONS } from "./library";
import { LMS_PERMISSIONS } from "./lms";
import { MEETING_PERMISSIONS } from "./meeting";
import { NOTIFICATION_PERMISSIONS } from "./notifications";
import { OPERATOR_PERMISSIONS } from "./operator";
import { POLL_PERMISSIONS } from "./poll";
import { PRIVACY_PERMISSIONS } from "./privacy";
import { SCHOLARSHIP_PERMISSIONS } from "./scholarship";
import { SECURITY_PERMISSIONS } from "./security";
import { SIS_PERMISSIONS } from "./sis";
import { TASK_PERMISSIONS } from "./task";
import { TIMETABLE_PERMISSIONS } from "./timetable";
import { TRANSPORT_PERMISSIONS } from "./transport";
import { WORKFLOW_PERMISSIONS } from "./workflow";

/** Every permission string the platform defines, sorted, de-duplicated. */
export const ALL_PERMISSIONS: readonly string[] = [
  ADMIN_PERMISSIONS,
  ADMISSION_PERMISSIONS,
  ALUMNI_PERMISSIONS,
  ANNOUNCEMENT_PERMISSIONS,
  ATTENDANCE_PERMISSIONS,
  BILLING_PERMISSIONS,
  CBT_PERMISSIONS,
  CERTIFICATE_PERMISSIONS,
  COMMUNICATION_PERMISSIONS,
  DISCIPLINE_PERMISSIONS,
  DISCUSSION_PERMISSIONS,
  DOCUMENT_PERMISSIONS,
  EXAM_PERMISSIONS,
  FEES_PERMISSIONS,
  FORM_PERMISSIONS,
  GAME_PERMISSIONS,
  GRADEBOOK_PERMISSIONS,
  HOSTEL_PERMISSIONS,
  HR_PERMISSIONS,
  INTEGRITY_PERMISSIONS,
  LIBRARY_PERMISSIONS,
  LMS_PERMISSIONS,
  MEETING_PERMISSIONS,
  NOTIFICATION_PERMISSIONS,
  OPERATOR_PERMISSIONS,
  POLL_PERMISSIONS,
  PRIVACY_PERMISSIONS,
  SCHOLARSHIP_PERMISSIONS,
  SECURITY_PERMISSIONS,
  SIS_PERMISSIONS,
  TASK_PERMISSIONS,
  TIMETABLE_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
  WORKFLOW_PERMISSIONS,
]
  .flatMap((domain) => Object.values(domain) as string[])
  .filter((v, i, a) => a.indexOf(v) === i)
  .sort();

/** The domain objects this list is built from — exported so a gate can prove the
 *  set is complete rather than trusting the import block above. */
export const PERMISSION_DOMAIN_COUNT = 34;
