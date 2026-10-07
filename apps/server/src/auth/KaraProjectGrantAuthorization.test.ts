import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { signProjectGrant } from "../KaraProjectGrant.ts";

const TEST_GRANT_SECRET = "kara-shared-project-grant-test-secret";
const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "127.0.0.1",
};

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-grant-auth-test-" })),
  );

const makeEnvironmentAuthLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

function makeGrantRequest(
  token: string,
  grant: string,
  request: { method?: string; url?: string } = {},
) {
  return {
    method: request.method ?? "GET",
    url: request.url ?? "http://localhost/api/orchestration/shell",
    cookies: {},
    headers: { authorization: `Bearer ${token}`, "x-kara-project-grant": grant },
  } as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];
}

function withGrantSecret<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const previous = process.env.T3CODE_ADMIN_BOOTSTRAP;
  process.env.T3CODE_ADMIN_BOOTSTRAP = TEST_GRANT_SECRET;
  return effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3CODE_ADMIN_BOOTSTRAP;
        else process.env.T3CODE_ADMIN_BOOTSTRAP = previous;
      }),
    ),
  );
}

it.layer(NodeServices.layer)("KARA project-grant session authorization", (it) => {
  it.effect(
    "accepts the seeded desktop administrator and rejects invalid scope, subject, and MAC",
    () => {
      return withGrantSecret(
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore.SessionStore;
          const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
          const grant = signProjectGrant(
            {
              v: 1,
              shareId: "11111111-1111-4111-8111-111111111111",
              projectId: "project-shared",
              subject: "shared-member",
              tenant: "tenant-a",
              role: "edit",
              exp: nowSeconds + 20,
            },
            TEST_GRANT_SECRET,
            nowSeconds,
          );
          const exchange = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
            "desktop-bootstrap-token",
            undefined,
            requestMetadata,
          );
          const accepted = yield* serverAuth.authenticateHttpRequest(
            makeGrantRequest(exchange.access_token, grant),
          );
          expect(accepted.subject).toBe("shared-member");
          expect(accepted.scopes).toEqual(["orchestration:read", "orchestration:operate"]);
          const deniedRoute = yield* serverAuth
            .authenticateHttpRequest(
              makeGrantRequest(exchange.access_token, grant, {
                url: "http://localhost/api/auth/session",
              }),
            )
            .pipe(Effect.flip);
          expect(deniedRoute._tag).toBe("ServerAuthInvalidCredentialError");
          const deniedMethod = yield* serverAuth
            .authenticateHttpRequest(
              makeGrantRequest(exchange.access_token, grant, { method: "POST" }),
            )
            .pipe(Effect.flip);
          expect(deniedMethod._tag).toBe("ServerAuthInvalidCredentialError");

          const missingScope = yield* sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            scopes: ["orchestration:read"],
          });
          const wrongSubject = yield* sessions.issue({
            subject: "ordinary-user",
            method: "bearer-access-token",
            scopes: AuthAdministrativeScopes,
          });
          const [prefix, payload, encodedMac] = grant.split(".");
          const mac = Buffer.from(encodedMac!, "base64url");
          mac[0] = (mac[0] ?? 0) ^ 1;
          const invalidMac = `${prefix}.${payload}.${mac.toString("base64url")}`;
          for (const [token, suppliedGrant] of [
            [missingScope.token, grant],
            [wrongSubject.token, grant],
            [exchange.access_token, invalidMac],
          ] as const) {
            const error = yield* serverAuth
              .authenticateHttpRequest(makeGrantRequest(token, suppliedGrant))
              .pipe(Effect.flip);
            expect(error._tag).toBe("ServerAuthInvalidCredentialError");
          }
        }).pipe(
          Effect.provide(
            makeEnvironmentAuthLayer({ desktopBootstrapToken: "desktop-bootstrap-token" }),
          ),
        ),
      );
    },
  );
});
