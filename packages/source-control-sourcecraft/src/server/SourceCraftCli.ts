import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  isMissingExecutable,
  probeSourceControlProvider,
  providerAuth,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { definition } from "../shared/definition.ts";
import { Profile } from "./sourceCraftJson.ts";

const loginHint =
  "Run `src auth login` in the project directory on the server to authenticate the environment selected by SourceCraft CLI.";
const installHint =
  "Install or update SourceCraft CLI (`src`) from https://sourcecraft.dev/portal/docs/ru/sourcecraft/operations/cli-quickstart, then run `src auth login`.";
const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProfile = Schema.decodeUnknownOption(Schema.fromJsonString(Profile));
// Serialize CLI calls because concurrent IAM refreshes can invalidate each other's credentials.
const processOptions = { env: { CI: "true" }, concurrency: { key: "sourcecraft", limit: 1 } };

function responseFromOutput(stdout: string) {
  const match = /^HTTP\/\d(?:\.\d)? ([1-5]\d{2})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/u.exec(stdout);
  return match ? { status: Number(match[1]), body: stdout.slice(match[0].length) } : null;
}

const needsLogin = (stderr: string) => /authentication required|not authenticated/iu.test(stderr);

export class SourceCraftCliError extends Schema.TaggedError<SourceCraftCliError>()(
  "SourceCraftCliError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "failed"]),
    status: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    if (this.detail) return this.detail;
    if (this.reason === "missing-tool") return installHint;
    if (this.reason === "unauthenticated") return loginHint;
    if (this.status === 403)
      return "SourceCraft denied access. Check the account's repository permissions.";
    if (this.status === 404)
      return "SourceCraft repository or pull request was not found in the selected environment.";
    if (this.status === 429) return "SourceCraft rate limit exceeded. Wait before retrying.";
    return `SourceCraft CLI request failed${this.status === undefined ? "" : ` (HTTP ${this.status})`}. Check the connection and repository configuration.`;
  }
}

export interface Request {
  readonly cwd: string;
  readonly host?: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH";
  readonly body?: unknown;
}

const Environments = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    active: Schema.Boolean,
    frontend: Schema.String,
    git: Schema.String,
  }),
);
const decodeEnvironments = Schema.decodeEffect(Schema.fromJsonString(Environments));
type Environment = (typeof Environments.Type)[number];

export function matchesEnvironment(environment: Environment, host: string) {
  const frontend = URL.parse(environment.frontend);
  const git = URL.parse(
    environment.git.includes("://") ? environment.git : `https://${environment.git}`,
  );
  return (
    host.toLowerCase() === frontend?.host.toLowerCase() ||
    host.toLowerCase() === git?.host.toLowerCase() ||
    (git?.hostname.startsWith("git.") === true &&
      host.toLowerCase() === git.host.toLowerCase().replace(/^git\./u, "ssh."))
  );
}

export class SourceCraftCli extends Context.Service<
  SourceCraftCli,
  {
    readonly environment: (cwd: string) => Effect.Effect<Environment, SourceCraftCliError>;
    readonly request: (input: Request) => Effect.Effect<string, SourceCraftCliError>;
  }
>()("@t3tools/source-control-sourcecraft/server/SourceCraftCli") {}

const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const environment = Effect.fn("SourceCraftCli.environment")(function* (cwd: string) {
    const operation = "environment";
    const output = yield* host.process
      .run({
        ...processOptions,
        operation: "SourceCraftCli.environment",
        command: "src",
        args: ["envs", "list", "--json"],
        cwd,
        stdin: "",
        timeoutMs: 5_000,
        maxOutputBytes: 256_000,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceCraftCliError({
              operation,
              reason: isMissingExecutable(cause) ? "missing-tool" : "failed",
              cause,
            }),
        ),
      );
    const environments = yield* decodeEnvironments(output.stdout).pipe(
      Effect.mapError((cause) => new SourceCraftCliError({ operation, reason: "failed", cause })),
    );
    const active = environments.filter((env) => env.active);
    const selected = active[0];
    const frontend = selected && URL.parse(selected.frontend);
    if (
      output.stdoutTruncated ||
      active.length !== 1 ||
      !selected ||
      !frontend ||
      !["https:", "http:"].includes(frontend.protocol)
    )
      return yield* new SourceCraftCliError({ operation, reason: "failed" });
    return selected;
  });
  return SourceCraftCli.of({
    environment,
    request: Effect.fn("SourceCraftCli.request")(function* (input) {
      const operation = input.method ?? "GET";
      const failure = (cause?: unknown) =>
        new SourceCraftCliError({ operation, reason: "failed", cause });
      if (!input.path.startsWith("/") || input.path.startsWith("//")) return yield* failure();
      if (input.host && !matchesEnvironment(yield* environment(input.cwd), input.host))
        return yield* new SourceCraftCliError({
          operation,
          reason: "failed",
          detail:
            "The requested host does not match the environment selected by src in this project directory. Check `src envs list` there.",
        });
      const stdin =
        input.body === undefined
          ? ""
          : yield* encodeBody(input.body).pipe(Effect.mapError(failure));
      const output = yield* host.process
        .run({
          ...processOptions,
          operation: "SourceCraftCli.request",
          command: "src",
          args: [
            "api",
            input.path,
            "--method",
            operation,
            "--include",
            ...(input.body === undefined ? [] : ["--input", "-"]),
          ],
          cwd: input.cwd,
          stdin,
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxOutputBytes: 16_000_000,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SourceCraftCliError({
                operation,
                reason: isMissingExecutable(cause) ? "missing-tool" : "failed",
                cause,
              }),
          ),
        );
      if (output.stdoutTruncated || output.stderrTruncated || output.stdoutInvalidUtf8)
        return yield* failure();
      const response = responseFromOutput(output.stdout);
      if (!response || response.status < 200 || response.status >= 300 || output.exitCode !== 0) {
        return yield* new SourceCraftCliError({
          operation,
          reason:
            response?.status === 401 || (!response && needsLogin(output.stderr))
              ? "unauthenticated"
              : "failed",
          ...(response ? { status: response.status } : {}),
        });
      }
      return response.body;
    }),
  });
});

const discovery: SourceControlCliDiscoverySpec = {
  type: "cli",
  kind: definition.kind,
  label: definition.label,
  installHint,
  executable: "src",
  versionArgs: ["--version"],
  authArgs: ["api", "/user", "--include"],
  parseAuth: (input) => {
    const response = responseFromOutput(input.stdout);
    const profile =
      response?.status === 200 && input.exitCode === 0
        ? decodeProfile(response.body)
        : Option.none();
    return Option.match(profile, {
      onSome: (profile) =>
        providerAuth({
          status: "authenticated",
          account: profile.username,
        }),
      onNone: () =>
        providerAuth({
          status:
            response?.status === 401 || (!response && needsLogin(input.stderr))
              ? "unauthenticated"
              : "unknown",
          detail:
            response?.status === 401 || needsLogin(input.stderr)
              ? loginHint
              : "Could not verify SourceCraft CLI authentication. Check the connection and update `src` if `src api` is unavailable.",
        }),
    });
  },
};

export const makeDiscovery = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const cli = yield* SourceCraftCli;
  return {
    type: "managed-cli",
    kind: definition.kind,
    label: definition.label,
    installHint,
    probe: Effect.fn("SourceCraftCli.probe")(function* (cwd) {
      const result = yield* probeSourceControlProvider({
        spec: discovery,
        cwd,
        process: { run: (input) => host.process.run({ ...input, ...processOptions, stdin: "" }) },
      });
      if (result.status === "missing") return result;
      const environment = yield* cli.environment(cwd).pipe(Effect.option);
      return {
        ...result,
        auth: {
          ...result.auth,
          host: Option.map(environment, (env) => new URL(env.frontend).host),
        },
      };
    }),
    refineUnknownRemote: ({ cwd, context }) =>
      cli.environment(cwd).pipe(
        Effect.map((env) => {
          const remote = parseGitRemoteHost(context.remoteUrl);
          return remote && matchesEnvironment(env, remote.host)
            ? {
                kind: definition.kind,
                name: definition.label,
                baseUrl: env.frontend.replace(/\/$/u, ""),
              }
            : null;
        }),
        Effect.catchIf(
          (error) => error.reason === "missing-tool",
          () => Effect.succeed(null),
        ),
      ),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

export const layer = Layer.effect(SourceCraftCli, make);
