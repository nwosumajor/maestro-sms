// =============================================================================
// MeetingService — video-meeting link validation + read gating
// =============================================================================
// Two behaviours protect this feature:
//   WRITE — a link is validated before it is ever stored (https + per-provider
//     host allowlist), and provider/url must arrive together, so a slot can never
//     hold a half-configured or attacker-pointed "Teams" meeting.
//   READ  — the link is released ONLY inside the server-computed join window; the
//     host always sees their own. A leaked early link is therefore unusable.

import { BadRequestException } from "@nestjs/common";
import { MeetingService } from "../../src/meeting/meeting.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService() {
  const create = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "slot1",
      teacherId: args.data.teacherId,
      startsAt: args.data.startsAt,
      endsAt: args.data.endsAt,
      capacity: args.data.capacity,
      location: args.data.location ?? null,
      note: args.data.note ?? null,
      active: true,
      provider: args.data.provider ?? null,
      joinUrl: args.data.joinUrl ?? null,
    }),
  );
  const tx = {
  // Capacity checks lock the contended row first (the class / route / slot),
  // so the count and the insert are atomic — the same guard hostel allocation
  // uses for a bed. The mock just has to answer.
  $executeRaw: jest.fn().mockResolvedValue(1),

    meetingSlot: { create, findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    meetingBooking: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
  } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new MeetingService(db as never, audit as never, notifications as never);
  return { service, create };
}

const host = (): Principal => ({ schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["meeting.host"] });

// A window comfortably in the future so the join gate is CLOSED.
const future = () => {
  const s = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const e = new Date(s.getTime() + 30 * 60 * 1000);
  return { startsAt: s.toISOString(), endsAt: e.toISOString() };
};
// A window happening right now so the gate is OPEN.
const now = () => {
  const s = new Date(Date.now() - 60 * 1000);
  const e = new Date(Date.now() + 29 * 60 * 1000);
  return { startsAt: s.toISOString(), endsAt: e.toISOString() };
};

describe("MeetingService video links", () => {
  it("stores a valid Teams link, normalised", async () => {
    const { service, create } = makeService();
    await service.createSlot(host(), {
      ...future(),
      provider: "TEAMS",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "TEAMS", joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" }),
      }),
    );
  });

  it("REFUSES a link whose host isn't the provider's (no attacker redirect)", async () => {
    const { service, create } = makeService();
    await expect(
      service.createSlot(host(), { ...future(), provider: "TEAMS", joinUrl: "https://teams.microsoft.com.evil.test/x" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("REFUSES non-https (blocks javascript: / downgrade)", async () => {
    const { service } = makeService();
    await expect(
      service.createSlot(host(), { ...future(), provider: "ZOOM", joinUrl: "http://zoom.us/j/1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createSlot(host(), { ...future(), provider: "OTHER", joinUrl: "javascript:alert(1)" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("REFUSES a provider without a URL, or a URL without a provider", async () => {
    const { service } = makeService();
    await expect(service.createSlot(host(), { ...future(), provider: "ZOOM" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createSlot(host(), { ...future(), joinUrl: "https://zoom.us/j/1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an in-person slot (neither field) is fine", async () => {
    const { service, create } = makeService();
    await service.createSlot(host(), { ...future(), location: "Room 4" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: null, joinUrl: null, location: "Room 4" }) }),
    );
  });

  it("the HOST sees their own link even before the window opens", async () => {
    const { service } = makeService();
    const dto = await service.createSlot(host(), {
      ...future(),
      provider: "MEET",
      joinUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(dto.provider).toBe("MEET");
    expect(dto.joinUrl).toBe("https://meet.google.com/abc-defg-hij"); // host
    expect(dto.joinOpen).toBe(false); // but the window is NOT open yet
    expect(dto.joinOpensAt).not.toBeNull();
  });

  it("joinOpen is true once the window is live", async () => {
    const { service } = makeService();
    const dto = await service.createSlot(host(), {
      ...now(),
      provider: "JITSI",
      joinUrl: "https://meet.jit.si/staff-standup",
    });
    expect(dto.joinOpen).toBe(true);
    expect(dto.joinUrl).toContain("meet.jit.si");
  });
});
