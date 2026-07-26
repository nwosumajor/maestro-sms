// =============================================================================
// FeedbackService — platform feedback scoping + scale-guard unit tests
// =============================================================================
// Proves: send() writes under the sender's OWN tenant tx and audits; a per-user
// hourly cap 429s a flood; listMine() reads only the sender's own rows;
// listAll()/stats()/review()/bulkReview() require the privileged (cross-tenant)
// client and 503 without it; digestSweep() no-ops without it and stays silent on
// a quiet window (the coalesced alert path — no per-submission email storm).

import { BadRequestException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { FeedbackService } from "../../src/feedback/feedback.service";
import { FEEDBACK_USER_HOURLY_CAP } from "../../src/feedback/feedback.constants";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(opts: { privilegedClient?: unknown; recentCount?: number } = {}) {
  const create = jest.fn().mockResolvedValue({ id: "fb1" });
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(opts.recentCount ?? 0);
  const tx = { platformFeedback: { create, findMany, count } } as unknown as TenantTx;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const privileged = { client: "privilegedClient" in opts ? opts.privilegedClient : null };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new FeedbackService(db as never, audit as never, privileged as never, notifications as never);
  return { service, audit, create, findMany, count, notifications };
}

const principal = (over: Partial<Principal> = {}): Principal => ({
  schoolId: "A",
  userId: "sender-1",
  roles: [],
  permissions: [],
  ...over,
});

describe("FeedbackService", () => {
  it("send() writes under the sender's tenant, stamps schoolId+userId, and audits", async () => {
    const { service, create, audit } = makeService();
    const res = await service.send(principal(), { kind: "COMPLAINT", subject: "Broken", body: "detail" });
    expect(res).toEqual({ id: "fb1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ schoolId: "A", userId: "sender-1", kind: "COMPLAINT" }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "feedback.send" }), expect.anything());
  });

  it("send() does NOT alert reviewers per submission (alerting is coalesced into the digest)", async () => {
    const { service, notifications } = makeService();
    await service.send(principal(), { kind: "SUGGESTION", subject: "x", body: "y" });
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("send() 429s once the per-user hourly cap is reached", async () => {
    const { service, create } = makeService({ recentCount: FEEDBACK_USER_HOURLY_CAP });
    await expect(service.send(principal(), { kind: "COMPLAINT", subject: "x", body: "y" })).rejects.toBeInstanceOf(HttpException);
    expect(create).not.toHaveBeenCalled();
  });

  it("send() rejects an unknown kind", async () => {
    const { service } = makeService();
    await expect(service.send(principal(), { kind: "SPAM", subject: "x", body: "y" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("listMine() reads only the caller's own rows", async () => {
    const { service, findMany } = makeService();
    await service.listMine(principal());
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "sender-1" } }));
  });

  it("listAll()/stats()/review()/bulkReview() 503 without a privileged client", async () => {
    const { service } = makeService();
    await expect(service.listAll(principal())).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.stats()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.review(principal(), "fb1", { status: "RESOLVED" })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.bulkReview(principal(), ["11111111-1111-1111-1111-111111111111"], { status: "DISMISSED" })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("digestSweep() no-ops (notifies no-one) without a privileged client", async () => {
    const { service, notifications } = makeService();
    await expect(service.digestSweep()).resolves.toEqual({ notified: 0, newOpen: 0 });
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });
});
