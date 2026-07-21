import { Controller, Get, Query } from "@nestjs/common";
import type { SearchResultDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { SearchService } from "./search.service";

// In-tenant global search. No @RequirePermission — every result category is
// gated INSIDE the service by the permission the caller holds, so a user only
// ever sees categories they're allowed to read.
@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  run(@CurrentPrincipal() p: Principal, @Query("q") q: string): Promise<SearchResultDto> {
    return this.search.search(p, q ?? "");
  }
}
