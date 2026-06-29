import { Module } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import { DirectorySearchService } from "./directory.service";

@Module({
  controllers: [DirectoryController],
  providers: [DirectorySearchService],
  exports: [DirectorySearchService],
})
export class DirectoryModule {}
