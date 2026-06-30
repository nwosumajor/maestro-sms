// Task System response DTOs (server form; Date fields are Date).

export interface TaskAssigneeDto {
  id: string;
  assigneeId: string;
  assigneeName: string;
  status: string;
  note: string | null;
  attachmentName: string | null;
  hasAttachment: boolean;
}

export interface TaskCommentDto {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  createdById: string;
  createdByName: string;
  status: string;
  dueAt: Date | null;
  assignees: TaskAssigneeDto[];
  comments: TaskCommentDto[];
  /** This caller's own assignment status (null if they are not an assignee). */
  myStatus: string | null;
  createdAt: Date;
}

/** Presigned upload URL for a task-assignment attachment. */
export interface TaskAttachmentPresignDto {
  url: string;
  key: string;
}
