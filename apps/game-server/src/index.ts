// Entrypoint for the standalone Dead & Wounded 2-player server (spec §11 step 2).
// No SMS dependency yet — identity is the connection's chosen display name; step
// 3 swaps this for SMS auth (JWT, school_id, RLS persistence).
import { createGameServer } from "./server";

const port = Number(process.env.PORT ?? 8080);
const server = createGameServer({ port });

server.wss.on("listening", () => {
  // eslint-disable-next-line no-console -- reason: standalone server startup log
  console.log(`[game-server] Dead & Wounded 2-player server listening on :${server.port()}`);
});
