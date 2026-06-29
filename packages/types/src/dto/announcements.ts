// School announcement DTOs.

export const ANNOUNCEMENT_AUDIENCES = ["ALL", "STUDENTS", "STAFF"] as const;
export type AnnouncementAudienceValue = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export interface AnnouncementDto {
  id: string;
  title: string;
  body: string;
  audience: string;
  authorName: string;
  createdAt: Date;
}
