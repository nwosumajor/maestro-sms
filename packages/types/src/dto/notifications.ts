// Notifications response DTOs.

export interface NotificationItemDto {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationInboxDto {
  items: NotificationItemDto[];
  unread: number;
}
