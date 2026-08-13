// =============================================================================
// Alumni broadcast — the fan-out, off the request
// =============================================================================
// Writing to an alumni body is unbounded work: alumni only accumulate, nobody
// stops being one. Doing it inside the HTTP request meant the administrator sat
// waiting while every recipient's inbox row, delivery row and audit row were
// written — measured at 12.9 SECONDS for 2,000 alumni even after chunking, and
// a school with ten thousand would pass the gateway timeout and get nothing but
// an error, with no way to tell how much had already gone out.
//
// The delivery of these notifications was ALREADY asynchronous. Only the writing
// of them was not, which is the part that scales with the roll.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ALUMNI_BROADCAST_QUEUE } from "./alumni.constants";
import { AlumniService } from "./alumni.service";

export interface AlumniBroadcastJob {
  schoolId: string;
  actorId: string;
  title: string;
  body: string;
  year?: number;
}

@Processor(ALUMNI_BROADCAST_QUEUE)
export class AlumniBroadcastProcessor extends WorkerHost {
  private readonly logger = new Logger("AlumniBroadcast");

  constructor(private readonly alumni: AlumniService) {
    super();
  }

  async process(job: Job<AlumniBroadcastJob>): Promise<void> {
    const { schoolId, actorId, title, body, year } = job.data;
    const sent = await this.alumni.fanOutBroadcast({ schoolId, actorId }, { title, body, year });
    // Says what it DID. A broadcast that reached nobody and one that had nobody
    // to reach are different facts, and only one needs looking into.
    this.logger.log(`school=${schoolId} broadcast written to ${sent} alumni`);
  }
}
