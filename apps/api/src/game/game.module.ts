import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameService } from "./game.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed. Reuses @sms/game-engine for the pure
// scoring/validation; persistence + tenancy + audit live in GameService.
@Module({
  controllers: [GameController],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
