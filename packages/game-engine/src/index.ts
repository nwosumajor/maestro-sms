// @sms/game-engine — Dead & Wounded game core (platform spec).
// Step 1 (§11.1): the pure scoring engine (`scoring`).
// Step 2 (§11.2): the server-authoritative 2-player match (`match`) + the
// swappable storage seam (`store`). All framework-independent: no I/O lives
// here; the WebSocket transport (apps/game-server) drives these. Every game
// mode depends on this core.
export * from "./scoring";
export * from "./match";
export * from "./store";
