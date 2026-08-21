import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/public.decorator";
import { ReplicaRouterService, type ReplicaState } from "./foundation/replica-router.service";

@Controller("health")
export class HealthController {
  constructor(private readonly router: ReplicaRouterService) {}

  /**
   * Liveness, plus where the reads are going.
   *
   * `replica` is the one piece of state an operator cannot get any other way
   * without Prometheus, and it is the first thing worth knowing when somebody
   * reports that a record they just saved "did not save": a degraded standby
   * explains it, and a healthy one rules it out. Deliberately no counts and no
   * tenant data — this endpoint is @Public.
   */
  @Public()
  @Get()
  check(): { status: string; service: string; ts: string; replica: ReplicaState } {
    return {
      status: "ok",
      service: "api",
      ts: new Date().toISOString(),
      replica: this.router.state(),
    };
  }
}
