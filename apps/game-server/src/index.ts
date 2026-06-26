// Entrypoint for the standalone Dead & Wounded server (spec §11 steps 2, 5, 6 & 8).
// One socket per connection, routed by path: `/ring` plays the Elimination Ring,
// `/race` the Class Race, `/arena` the Ultimate cross-school arena, anything else
// the 2-player duel. No SMS dependency yet — identity is the connection's chosen
// display name / handle; step 3 swaps this for SMS auth (JWT, school_id, RLS).
import { createGameServer } from "./server";

const port = Number(process.env.PORT ?? 8080);
const server = createGameServer({ port });

server.wss.on("listening", () => {
  // eslint-disable-next-line no-console -- reason: standalone server startup log
  console.log(
    `[game-server] Dead & Wounded server listening on :${server.port()} (duel: /, ring: /ring, race: /race, arena: /arena)`,
  );
});
