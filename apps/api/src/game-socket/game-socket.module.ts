import { Module } from "@nestjs/common";
import { GameSocketGateway } from "./game-socket.gateway";

// Hosts the live game WebSocket gateway. The gateway is attached to the http
// server in main.ts after `app.listen()`; this module just provides + exports it.
@Module({
  providers: [GameSocketGateway],
  exports: [GameSocketGateway],
})
export class GameSocketModule {}
