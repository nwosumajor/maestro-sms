import { Global, Module } from "@nestjs/common";
import { PrivilegedDatabaseService } from "./privileged-database.service";

// Global so any privileged consumer can inject the single shared client without
// importing a module graph. There is exactly ONE instance per Nest process.
@Global()
@Module({
  providers: [PrivilegedDatabaseService],
  exports: [PrivilegedDatabaseService],
})
export class PrivilegedDatabaseModule {}
