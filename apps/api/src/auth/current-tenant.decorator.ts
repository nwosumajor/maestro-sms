import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { AuthedRequest } from "./permission.guard";
import type { TenantContext } from "../integrity/integrity.foundation";

/** Inject the request's tenant context ({ schoolId, userId }) from the JWT. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.principal) throw new UnauthorizedException();
    return { schoolId: req.principal.schoolId, userId: req.principal.userId };
  },
);
