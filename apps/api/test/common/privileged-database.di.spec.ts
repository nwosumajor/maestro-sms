// =============================================================================
// PrivilegedDatabaseModule — DI wiring smoke test
// =============================================================================
// The 6 privileged consumers now share ONE client via the @Global
// PrivilegedDatabaseModule + token `useExisting` re-bindings. This proves the
// module exports the service, that a consumer can inject it, and that a token
// aliased with useExisting resolves to the SAME singleton instance (one pool).

import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrivilegedDatabaseModule } from "../../src/common/privileged-database.module";
import { PrivilegedDatabaseService } from "../../src/common/privileged-database.service";

const ALIAS = Symbol("ALIAS_DB");

@Injectable()
class DirectConsumer {
  constructor(public readonly db: PrivilegedDatabaseService) {}
}
@Injectable()
class TokenConsumer {
  constructor(@Inject(ALIAS) public readonly db: PrivilegedDatabaseService) {}
}

// Mirrors how billing/hr/retention rebind their token to the shared service.
@Global()
@Module({
  providers: [DirectConsumer, TokenConsumer, { provide: ALIAS, useExisting: PrivilegedDatabaseService }],
})
class ConsumersModule {}

describe("PrivilegedDatabaseModule DI", () => {
  it("injects the shared service directly and via a useExisting token (same singleton)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrivilegedDatabaseModule, ConsumersModule],
    }).compile();
    await moduleRef.init();

    const shared = moduleRef.get(PrivilegedDatabaseService);
    const direct = moduleRef.get(DirectConsumer);
    const viaToken = moduleRef.get(TokenConsumer);

    expect(direct.db).toBe(shared); // one instance — direct injection
    expect(viaToken.db).toBe(shared); // useExisting aliases to the SAME singleton
    // The getter resolves whether or not a privileged URL is configured (null when
    // disabled — the least-privilege default; a client when set). Either way: one pool.
    expect("client" in shared).toBe(true);

    await moduleRef.close();
  });
});
