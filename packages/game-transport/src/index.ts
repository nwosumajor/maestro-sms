// @sms/game-transport — transport-agnostic, server-authoritative orchestration for
// the Dead & Wounded modes, plus handshake JWT auth. A "connection" is just an id
// + a `send` callback, so these services have no socket dependency: they are driven
// equally by the standalone `ws` server (apps/game-server) and the SMS NestJS
// gateway (apps/api). All game authority lives in @sms/game-engine; this layer maps
// wire protocols to it and broadcasts the engine's redacted views.

// Handshake auth (shared HS256 / AUTH_SECRET verification).
export * from "./auth";

// Wire protocols (one per mode).
export * from "./protocol";
export * from "./ring-protocol";
export * from "./race-protocol";
export * from "./arena-protocol";

// Orchestration services (one per mode).
export * from "./game-service";
export * from "./ring-service";
export * from "./race-service";
export * from "./arena-service";
