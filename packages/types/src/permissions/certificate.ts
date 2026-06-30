// Certificate / ID-card generator.
export const CERTIFICATE_PERMISSIONS = {
  /** Issue ID cards + certificates (generates a PDF, logs issuance). Staff. */
  CERTIFICATE_ISSUE: "certificate.issue",
} as const;
export type CertificatePermission = (typeof CERTIFICATE_PERMISSIONS)[keyof typeof CERTIFICATE_PERMISSIONS];
