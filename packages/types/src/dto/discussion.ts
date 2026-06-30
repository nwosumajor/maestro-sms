// Discussion Hub response DTOs (server form; Date fields are Date).

export interface DiscussionCommentDto {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  deleted: boolean;
  createdAt: Date;
}

export interface DiscussionPostDto {
  id: string;
  groupId: string;
  authorId: string;
  authorName: string;
  body: string;
  deleted: boolean;
  comments: DiscussionCommentDto[];
  createdAt: Date;
}

export interface DiscussionGroupDto {
  id: string;
  name: string;
  description: string | null;
  audience: string;
  createdByName: string;
  postCount: number;
  createdAt: Date;
}
