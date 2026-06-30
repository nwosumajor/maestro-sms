import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { TASK_PERMISSIONS } from "@sms/types";
import { MODULES } from "@sms/types";
import type { TaskAttachmentPresignDto, TaskDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { TaskService } from "./task.service";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  dueAt: z.string().nullish(),
  assigneeIds: z.array(z.string().uuid()).min(1).max(100),
});
const statusSchema = z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"]) });
const myUpdateSchema = z.object({
  status: z.enum(["ASSIGNED", "IN_PROGRESS", "SUBMITTED", "DONE"]).optional(),
  note: z.string().max(2000).optional(),
});
const presignSchema = z.object({ fileName: z.string().min(1).max(200), contentType: z.string().min(1).max(120) });
const confirmSchema = z.object({ key: z.string().min(1).max(400), fileName: z.string().min(1).max(200) });
const commentSchema = z.object({ body: z.string().min(1).max(2000) });

@RequireModule(MODULES.TASK)
@Controller("tasks")
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Get()
  @RequirePermission(TASK_PERMISSIONS.TASK_PARTICIPATE)
  list(@CurrentPrincipal() p: Principal): Promise<TaskDto[]> {
    return this.tasks.listTasks(p);
  }

  @Post()
  @RequirePermission(TASK_PERMISSIONS.TASK_ASSIGN)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(createSchema)) b: z.infer<typeof createSchema>): Promise<TaskDto> {
    return this.tasks.createTask(p, b);
  }

  @Put(":id/status")
  @RequirePermission(TASK_PERMISSIONS.TASK_ASSIGN)
  setStatus(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(statusSchema)) b: z.infer<typeof statusSchema>): Promise<TaskDto> {
    return this.tasks.setStatus(p, id, b.status);
  }

  /** An assignee updates their own assignment status/note. */
  @Put(":id/me")
  @RequirePermission(TASK_PERMISSIONS.TASK_PARTICIPATE)
  updateMine(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(myUpdateSchema)) b: z.infer<typeof myUpdateSchema>): Promise<TaskDto> {
    return this.tasks.updateMyAssignment(p, id, b);
  }

  @Post(":id/attachment/presign")
  @RequirePermission(TASK_PERMISSIONS.TASK_PARTICIPATE)
  presign(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(presignSchema)) b: z.infer<typeof presignSchema>): Promise<TaskAttachmentPresignDto> {
    return this.tasks.presignAttachment(p, id, b);
  }

  @Post(":id/attachment/confirm")
  @RequirePermission(TASK_PERMISSIONS.TASK_PARTICIPATE)
  confirm(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(confirmSchema)) b: z.infer<typeof confirmSchema>): Promise<TaskDto> {
    return this.tasks.confirmAttachment(p, id, b);
  }

  @Get(":id/assignments/:assignmentId/attachment")
  @RequirePermission(TASK_PERMISSIONS.TASK_PARTICIPATE)
  download(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Param("assignmentId") assignmentId: string): Promise<{ url: string }> {
    return this.tasks.downloadAttachment(p, id, assignmentId);
  }

  @Post(":id/comments")
  @RequirePermission(TASK_PERMISSIONS.TASK_PARTICIPATE)
  comment(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(commentSchema)) b: z.infer<typeof commentSchema>): Promise<TaskDto> {
    return this.tasks.comment(p, id, b.body);
  }
}
