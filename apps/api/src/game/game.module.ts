import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameService } from "./game.service";
import { CompetitionController } from "./competition.controller";
import { CompetitionService } from "./competition.service";
import { RaceController } from "./race.controller";
import { RaceService } from "./race.service";
import { RingController } from "./ring.controller";
import { RingService } from "./ring.service";
import { GameSettingsController } from "./game-settings.controller";
import { GameSettingsService } from "./game-settings.service";
import { UltimateController } from "./ultimate.controller";
import { UltimateService } from "./ultimate.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed. Reuses @sms/game-engine for the pure
// scoring/validation/bracket/standings logic; persistence + tenancy + audit live
// in the services.
//
// Dependency direction is one-way (no cycle): GameService depends on
// CompetitionService for the post-match hook (a competition match resolving →
// standings/bracket update). CompetitionService does NOT depend on GameService —
// it writes its own forfeit finishes for the overdue-match sweep.
// RaceService (Class Race, spec §5) is independent of GameService — a RACE has
// no turns/opponents and never routes through the duel service.
@Module({
  controllers: [
    GameController,
    CompetitionController,
    RaceController,
    RingController,
    GameSettingsController,
    UltimateController,
  ],
  providers: [
    GameService,
    CompetitionService,
    RaceService,
    RingService,
    GameSettingsService,
    UltimateService,
  ],
  exports: [
    GameService,
    CompetitionService,
    RaceService,
    RingService,
    GameSettingsService,
    UltimateService,
  ],
})
export class GameModule {}
