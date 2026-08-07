import { Controller, Get, Query } from "@nestjs/common";
import { ADMIN_PERMISSIONS } from "@sms/types";
import type { PersonSearchResultDto, UserSummaryDto } from "@sms/types";
import { z } from "zod";
import { USER_KINDS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DirectorySearchService } from "./directory.service";
import { PeopleOptionsService } from "./people.service";

const searchSchema = z.object({
  q: z.string().max(120).optional(),
  school: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  role: z.string().max(40).optional(),
});

const peopleSchema = z.object({
  kind: z.enum(USER_KINDS).optional(),
  q: z.string().max(120).optional(),
});

@Controller("directory")
export class DirectoryController {
  constructor(
    private readonly directory: DirectorySearchService,
    private readonly people: PeopleOptionsService,
  ) {}

  /** Picker options: id + name + roles, never an email. See PeopleOptionsService
   *  for why this is separate from GET /users — twelve features read that one,
   *  which needs class.write, so eight roles got an EMPTY picker and no error. */
  @Get("people")
  @RequirePermission(ADMIN_PERMISSIONS.PEOPLE_READ)
  people_(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(peopleSchema)) query: z.infer<typeof peopleSchema>,
  ): Promise<UserSummaryDto[]> {
    return this.people.list(p, query.kind, query.q);
  }

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
