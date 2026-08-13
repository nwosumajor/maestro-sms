import { Global, Module } from "@nestjs/common";
import { PrivilegedDatabaseModule } from "../common/privileged-database.module";
import { JobRunsService } from "./job-runs.service";

// @Global because every scheduled processor across the app records through it,
// and threading an import edge from thirteen feature modules to this one would
// add graph coupling for a single shared writer. The same reasoning as
// PrivilegedDatabaseModule, which it depends on.
@Global()
@Module({
  imports: [PrivilegedDatabaseModule],
  providers: [JobRunsService],
  exports: [JobRunsService],
})
export class JobRunsModule {}
