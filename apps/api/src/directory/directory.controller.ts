import { Controller, Get, Query } from "@nestjs/common";
import { ADMIN_PERMISSIONS } from "@sms/types";
import type { PersonSearchResultDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DirectorySearchService } from "./directory.service";

const searchSchema = z.object({
  q: z.string().max(120).optional(),
  school: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  role: z.string().max(40).optional(),
});

@Controller("directory")
export class DirectoryController {
  constructor(private readonly directory: DirectorySearchService) {}

  /** Search people. super_admin → all schools; principal/school_admin → own school. */
  @Get("search")
  @RequirePermission(ADMIN_PERMISSIONS.DIRECTORY_SEARCH)
  search(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(searchSchema)) query: z.infer<typeof searchSchema>,
  ): Promise<PersonSearchResultDto[]> {
    return this.directory.search(p, query);
  }
}
