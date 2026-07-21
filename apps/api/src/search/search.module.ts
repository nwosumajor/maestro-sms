import { Module } from "@nestjs/common";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

// Depends on the global FoundationModule (TENANT_DATABASE, auth guard).
@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
