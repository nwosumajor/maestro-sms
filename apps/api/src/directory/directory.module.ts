import { Module } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import { DirectorySearchService } from "./directory.service";
import { PeopleOptionsService } from "./people.service";

@Module({
  controllers: [DirectoryController],
  providers: [DirectorySearchService, PeopleOptionsService],
  exports: [DirectorySearchService],
})
export class DirectoryModule {}
