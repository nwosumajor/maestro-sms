// Messaging response DTOs. Contacts reuse UserSummaryDto.

export interface ThreadSummaryDto {
  id: string;
  subject: string;
  updatedAt: Date;
  unread: number;
  lastMessage: { body: string } | null;
}

export interface MessageDto {
  id: string;
  senderId: string;
  body: string;
  createdAt: Date;
}

export interface ThreadViewDto {
  thread: { id: string; subject: string };
  messages: MessageDto[];
}
