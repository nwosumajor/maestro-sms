import { SetMetadata } from "@nestjs/common";

export const PUBLIC_KEY = "sms:public";

/** Mark a route as not requiring authentication (e.g. health check). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
