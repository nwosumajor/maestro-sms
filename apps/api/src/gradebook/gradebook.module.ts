import { Module } from "@nestjs/common";
import { GradebookController } from "./gradebook.controller";
import { GradebookService } from "./gradebook.service";

@Module({
  controllers: [GradebookController],
  providers: [GradebookService],
  exports: [GradebookService],
})
export class GradebookModule {}
