import { SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Cli from "./SourceCraftCli.ts";

it.effect("sends JSON on stdin using the CLI environment and preserves the response body", () => {
  const body = { title: "quotes ' \" and $(no-shell)\nстрока", publish: true };
  const layer = Cli.layer.pipe(
    Layer.provide(
      TestHost.layer({
        process: {
          run: (input) => {
            expect(input.command).toBe("src");
            expect(input.args).toEqual([
              "api",
              "/repos/org/repo/pulls",
              "--method",
              "POST",
              "--include",
              "--input",
              "-",
            ]);
            expect(JSON.parse(input.stdin ?? "")).toEqual(body);
            expect(input.env).toEqual({ CI: "true" });
            expect(input.args).not.toContain("--env");
            expect(input.concurrency).toEqual({ key: "sourcecraft", limit: 1 });
            return Effect.succeed(
              TestHost.processOutput(
                'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"slug":"42"}\n',
              ),
            );
          },
        },
      }),
    ),
  );
  return Effect.gen(function* () {
    const cli = yield* Cli.SourceCraftCli;
    expect(
      yield* cli.request({ cwd: "/repo", path: "/repos/org/repo/pulls", method: "POST", body }),
    ).toBe('{"slug":"42"}\n');
  }).pipe(Effect.provide(layer));
});

it.effect("distinguishes HTTP errors, missing login, malformed and truncated CLI responses", () =>
  Effect.gen(function* () {
    for (const sample of [
      { stdout: "HTTP/1.1 401 Unauthorized\r\n\r\n{}", status: 401, reason: "unauthenticated" },
      { stdout: "HTTP/2.0 403 Forbidden\n\n{}", status: 403, reason: "failed" },
      { stdout: "HTTP/2.0 404 Not Found\n\n{}", status: 404, reason: "failed" },
      { stdout: "HTTP/2.0 429 Too Many Requests\n\n{}", status: 429, reason: "failed" },
      {
        stdout: "",
        stderr: "OPERATION FAILED: Authentication required",
        reason: "unauthenticated",
      },
      { stdout: "", stderr: 'unknown command "api"', reason: "failed" },
      { stdout: "HTTP/2.0 200 OK\n\n{}", truncated: true, reason: "failed" },
    ]) {
      const layer = Cli.layer.pipe(
        Layer.provide(
          TestHost.layer({
            process: {
              run: () =>
                Effect.succeed({
                  ...TestHost.processOutput(sample.stdout, {
                    stderr: sample.stderr ?? "",
                    exitCode: ChildProcessSpawner.ExitCode(sample.truncated ? 0 : 1),
                  }),
                  stdoutTruncated: sample.truncated ?? false,
                }),
            },
          }),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const cli = yield* Cli.SourceCraftCli;
        return yield* cli.request({ cwd: "/repo", path: "/user" }).pipe(Effect.result);
      }).pipe(Effect.provide(layer));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: sample.reason, ...(sample.status ? { status: sample.status } : {}) },
      });
    }
  }),
);

it.effect("discovers the CLI account and separates an expired login from a failed probe", () =>
  Effect.gen(function* () {
    for (const sample of [
      {
        stdout: 'HTTP/2.0 200 OK\r\n\r\n{"id":"user-id","username":"alice"}',
        exitCode: 0,
        status: "authenticated",
        account: "alice",
      },
      { stdout: "HTTP/2.0 401 Unauthorized\n\n{}", exitCode: 1, status: "unauthenticated" },
      {
        stdout: "",
        stderr: "OPERATION FAILED: Authentication required",
        exitCode: 4,
        status: "unauthenticated",
      },
      { stdout: "", stderr: "connection refused", exitCode: 1, status: "unknown" },
    ]) {
      const discovery = yield* Cli.makeDiscovery.pipe(
        Effect.provide(
          Cli.layer.pipe(
            Layer.provideMerge(
              TestHost.layer({
                process: {
                  run: (input) => {
                    expect(input.env).toEqual({ CI: "true" });
                    expect(input.args).not.toContain("--env");
                    expect(input.stdin).toBe("");
                    expect(input.concurrency).toEqual({ key: "sourcecraft", limit: 1 });
                    return Effect.succeed(
                      input.args[0] === "envs"
                        ? TestHost.processOutput(
                            '[ {"name":"Custom","active":true,"frontend":"https://code.example.test","git":"git.example.test"} ]',
                          )
                        : input.args.includes("--version")
                          ? TestHost.processOutput("Version: 0.0.121\nPlatform: darwin/arm64")
                          : TestHost.processOutput(sample.stdout, {
                              stderr: sample.stderr ?? "",
                              exitCode: ChildProcessSpawner.ExitCode(sample.exitCode),
                            }),
                    );
                  },
                },
              }),
            ),
          ),
        ),
      );
      const result = yield* discovery.probe("/repo");
      expect(result.status).toBe("available");
      expect(result.auth.status).toBe(sample.status);
      expect(Option.getOrUndefined(result.auth.host)).toBe("code.example.test");
      expect(Option.getOrUndefined(result.auth.account)).toBe(sample.account);
    }
  }),
);

it.effect(
  "uses custom environment metadata and rejects a different host before sending a write",
  () => {
    let apiCalls = 0;
    let frontend = "https://code.example.test:8443";
    const host = TestHost.layer({
      process: {
        run: (input) => {
          expect(input.args).not.toContain("--env");
          if (input.args[0] === "envs")
            return Effect.succeed(
              TestHost.processOutput(
                JSON.stringify([
                  {
                    name: "ExtProd",
                    active: false,
                    frontend: "https://sourcecraft.dev",
                    git: "git.sourcecraft.dev",
                  },
                  { name: "my-custom-env", active: true, frontend, git: "git.example.test" },
                ]),
              ),
            );
          apiCalls++;
          return Effect.succeed(TestHost.processOutput("HTTP/2.0 204 No Content\r\n\r\n"));
        },
      },
    });
    return Effect.gen(function* () {
      const cli = yield* Cli.SourceCraftCli;
      expect((yield* cli.environment("/custom-checkout")).frontend).toBe(frontend);
      yield* cli.request({
        cwd: "/custom-checkout",
        host: "code.example.test:8443",
        path: "/repos/org/repo/pulls/42/discard",
        method: "POST",
      });
      const denied = yield* cli
        .request({
          cwd: "/custom-checkout",
          host: "sourcecraft.dev",
          path: "/repos/org/repo/pulls/42/discard",
          method: "POST",
        })
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      expect(apiCalls).toBe(1);
      const discovery = yield* Cli.makeDiscovery;
      const context = {
        provider: {
          kind: SourceControlProviderKind.make("unknown"),
          name: "unknown",
          baseUrl: "https://git.example.test",
        },
        remoteName: "origin",
        remoteUrl: "git@git.example.test:org/repo.git",
      };
      expect(
        yield* discovery.refineUnknownRemote({ cwd: "/custom-checkout", context }),
      ).toMatchObject({ kind: "sourcecraft", baseUrl: frontend });
      expect(
        yield* discovery.refineUnknownRemote({
          cwd: "/custom-checkout",
          context: { ...context, remoteUrl: "git@unrelated.example.test:org/repo.git" },
        }),
      ).toBeNull();
      frontend = "https://new.example.test";
      expect((yield* cli.environment("/custom-checkout")).frontend).toBe(frontend);
    }).pipe(Effect.provide(Cli.layer.pipe(Layer.provideMerge(host))));
  },
);

it("recognizes an environment's SSH endpoint without confusing another environment", () => {
  const environment = {
    name: "Custom",
    active: true,
    frontend: "https://code.example.test",
    git: "git.example.test",
  };
  expect(Cli.matchesEnvironment(environment, "ssh.example.test")).toBe(true);
  expect(Cli.matchesEnvironment(environment, "ssh.other.test")).toBe(false);
});
