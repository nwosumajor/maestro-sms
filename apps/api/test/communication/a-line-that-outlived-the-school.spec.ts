// =============================================================================
// A private line to a child that outlived the school
// =============================================================================
// Starting a thread requires the relationship: a teacher may write to the pupils
// they teach, ACTIVE enrolment only — "a pupil who has left is no longer theirs
// to write to" is written in `recipientScope` itself.
//
// Replying required only that you were already a participant. So a channel
// opened legitimately went on working after the child left the school: two
// participants, nobody else able to see it, and no remaining role connecting
// the adult to the child. Every thread in the live database has exactly two
// participants.
//
// WHY THIS AND NOT A CLASS CHANGE. Blocking a teacher from answering a pupil
// who is still in the school — who asked something last week and changed set
// this term — does not end the conversation. It moves it to WhatsApp, where the
// school can see nothing at all, which is the opposite of the point. While the
// child is here there is a continuing pastoral role and ordinary supervision.
// Once they have gone there is neither, and the school office remains reachable
// for the things that genuinely continue: a transcript, a final report.
//
// The thread STAYS READABLE. History is a safeguarding record, and removing
// reach must not remove evidence.
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import { MessagingService } from "../../src/communication/messaging.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(other: { id: string; name: string; exitedStudent: boolean }) {
  const create = jest.fn().mockResolvedValue({ id: "m-1" });
  // Mirrors the real query: it asks for an EXITED user holding the student
  // role, so anything else comes back null.
  const userFindFirst = jest.fn(({ where }: { where: { status?: string; roles?: unknown } }) =>
    Promise.resolve(where.status === "EXITED" && where.roles && other.exitedStudent ? { name: other.name } : null),
  );
  const tx = {
    threadParticipant: {
      findFirst: jest.fn().mockResolvedValue({ id: "tp-1" }),
      findMany: jest.fn().mockResolvedValue([{ userId: other.id }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    message: { create },
    messageThread: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ subject: "Homework" }),
    },
    user: { findFirst: userFindFirst },
  } as unknown as TenantTx;
  const svc = Object.create(MessagingService.prototype) as MessagingService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    notifications: { enqueue: jest.fn().mockResolvedValue(undefined) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc, create, userFindFirst };
}

const who = (roles: string[]): Principal => ({ schoolId: "A", userId: "me", roles, permissions: [] });

describe("replying to a pupil who has left the school", () => {
  it("is refused for the teacher who taught them", async () => {
    const { svc, create } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: true });
    await expect(svc.reply(who(["teacher"]), "t-1", "hello")).rejects.toThrow(ForbiddenException);
    // Refused BEFORE the message exists, not cleaned up afterwards.
    expect(create).not.toHaveBeenCalled();
  });

  it("names the pupil and where to go instead", async () => {
    // A refusal that does not say what to do next sends somebody to support, or
    // to a channel the school cannot see.
    const { svc } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: true });
    await expect(svc.reply(who(["teacher"]), "t-1", "hello")).rejects.toThrow(
      /Ada Obi has left the school[\s\S]*school office can pass a message on/,
    );
  });

  it("is refused for a warden too", async () => {
    // Hostel-scoped reach ends the same way class-scoped reach does.
    const { svc, create } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: true });
    await expect(svc.reply(who(["warden"]), "t-1", "hello")).rejects.toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it("is ALLOWED for the school office", async () => {
    // Exactly who should still be reachable about a transcript or a final
    // report — and the person the refusal above points at.
    const { svc, create } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: true });
    await expect(svc.reply(who(["school_admin"]), "t-1", "hello")).resolves.toMatchObject({ id: "m-1" });
    expect(create).toHaveBeenCalled();
  });

  it("does not even ask when the caller is whole-school", async () => {
    const { svc, userFindFirst } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: true });
    await svc.reply(who(["principal"]), "t-1", "hello");
    expect(userFindFirst).not.toHaveBeenCalled();
  });
});

describe("what this deliberately does not touch", () => {
  it("a pupil still in the school, whatever class they are now in", async () => {
    // The class-change case. Blocking it would move the conversation to a
    // channel the school cannot see, which is worse than the thing it prevents.
    const { svc, create } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: false });
    await expect(svc.reply(who(["teacher"]), "t-1", "hello")).resolves.toMatchObject({ id: "m-1" });
    expect(create).toHaveBeenCalled();
  });

  it("a thread with an adult", async () => {
    // A departed COLLEAGUE is not a safeguarding question, and the check asks
    // for the student role precisely so it is not treated as one.
    const { svc, create } = makeService({ id: "staff-9", name: "A Colleague", exitedStudent: false });
    await expect(svc.reply(who(["teacher"]), "t-1", "hello")).resolves.toMatchObject({ id: "m-1" });
    expect(create).toHaveBeenCalled();
  });

  it("asks only about the people actually in this thread", async () => {
    const { svc, userFindFirst } = makeService({ id: "kid-1", name: "Ada Obi", exitedStudent: false });
    await svc.reply(who(["teacher"]), "t-1", "hello");
    // The role filter is asserted HERE, on the query, rather than inferred from
    // how the stub behaves — otherwise the mock would be encoding the rule it
    // is supposed to be testing.
    expect(userFindFirst.mock.calls[0][0].where).toMatchObject({
      id: { in: ["kid-1"] },
      status: "EXITED",
      roles: { some: { role: { name: "student" } } },
    });
  });
});
