import { Module } from "@nestjs/common";
import { GameSocketGateway } from "./game-socket.gateway";
import { GameModule } from "../game/game.module";

// Hosts the live game WebSocket gateway. The gateway is attached to the http
// server in main.ts after `app.listen()`; this module just provides + exports it.
// Imports GameModule so the `/ws/watch` path can inject the durable GameService
// (RLS-scoped re-read) and GameEventsService (the "game changed" pub/sub).
@Module({
  imports: [GameModule],
  providers: [GameSocketGateway],
  exports: [GameSocketGateway],
})
export class GameSocketModule {}
