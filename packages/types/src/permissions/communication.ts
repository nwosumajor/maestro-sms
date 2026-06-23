// =============================================================================
// Messaging + Calendar — permission constants
// =============================================================================
// Messaging is available to everyone (scoped to threads you participate in;
// non-staff may only start threads with staff/teachers). Calendar read is for
// everyone; creating events is a staff action.
// =============================================================================

export const COMMUNICATION_PERMISSIONS = {
  MESSAGE_READ: "message.read",
  MESSAGE_SEND: "message.send",
  EVENT_READ: "event.read",
  EVENT_WRITE: "event.write",
} as const;

export type CommunicationPermission =
  (typeof COMMUNICATION_PERMISSIONS)[keyof typeof COMMUNICATION_PERMISSIONS];
