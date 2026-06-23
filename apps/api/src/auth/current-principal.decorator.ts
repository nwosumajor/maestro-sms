import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { AuthedRequest } from "./permission.guard";
import type { Principal } from "./principal";

/** Inject the full verified Principal (incl. roles) for relationship scoping. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.principal) throw new UnauthorizedException();
    return req.principal;
  },
);
