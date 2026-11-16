import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceCraftCli from "./SourceCraftCli.ts";
import * as Provider from "./SourceCraftSourceControlProvider.ts";
import { definition } from "../shared/definition.ts";

const pull = {
  id: "opaque-uuid",
  slug: "42",
  title: "Add feature",
  source: { ref: "feature", sha: "abc", label: "team/repo:feature" },
  target: { ref: "main", sha: "def", label: "team/repo:main" },
  status: "draft",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const context = {
  provider: { kind: definition.kind, name: "SourceCraft", baseUrl: "https://sourcecraft.dev" },
  remoteName: "origin",
  remoteUrl: "git@sourcecraft.dev:team/repo.git",
};
const setup = (
  request: SourceCraftCli.SourceCraftCli["Service"]["request"],
  frontend = "https://sourcecraft.dev",
  git = "git.sourcecraft.dev",
) =>
  Provider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(SourceCraftCli.SourceCraftCli, {
          request,
          environment: () =>
            Effect.succeed({
              name: "ExtProd",
              active: true,
              frontend,
              git,
            }),
        }),
        TestHost.layer(),
        FileSystem.layerNoop({ readFileString: () => Effect.succeed("Description\nwith lines") }),
      ),
    ),
  );

describe("SourceCraft source control", () => {
  it.effect("uses the public PR number and preserves draft and fork identity", () =>
    Effect.gen(function* () {
      const provider = yield* setup(() =>
        Effect.succeed(
          JSON.stringify({
            ...pull,
            source: { ...pull.source, label: "contributor/fork:feature" },
          }),
        ),
      );
      const result = yield* provider.getChangeRequest({
        cwd: "/repo",
        context,
        reference: "https://sourcecraft.dev/team/repo/pr/42",
      });
      expect(result).toMatchObject({
        number: 42,
        state: "open",
        isDraft: true,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "contributor/fork",
        url: "https://sourcecraft.dev/team/repo/pr/42",
      });
    }),
  );
  it.effect("continues past filtered pages and retains merging PRs as open", () =>
    Effect.gen(function* () {
      const provider = yield* setup((input) =>
        Effect.succeed(
          JSON.stringify(
            input.path.includes("page_token=next")
              ? { pull_requests: [{ ...pull, status: "merging" }] }
              : { pull_requests: [{ ...pull, status: "discarded" }], next_page_token: "next" },
          ),
        ),
      );
      const result = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "open",
        limit: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ state: "open", isDraft: false });
    }),
  );
  it.effect("rejects foreign PR URLs before making an API call", () =>
    Effect.gen(function* () {
      const provider = yield* setup(() => Effect.die("Unexpected request"));
      const result = yield* provider
        .getChangeRequest({
          cwd: "/repo",
          context,
          reference: "https://example.com/team/repo/pr/42",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("creates a published fork PR using the source repository ID", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const provider = yield* setup((input) => {
        if (input.method === "POST") {
          writes.push(input.body);
          return Effect.succeed(JSON.stringify(pull));
        }
        return Effect.succeed(
          JSON.stringify({
            id: "fork-id",
            slug: "fork",
            organization: { slug: "contributor" },
            clone_url: {
              https: "https://sourcecraft.dev/contributor/fork.git",
              ssh: "git@sourcecraft.dev:contributor/fork.git",
            },
          }),
        );
      });
      yield* provider.createChangeRequest({
        cwd: "/repo",
        context,
        headSelector: "feature",
        source: { repository: "contributor/fork", refName: "feature" },
        baseRefName: "main",
        title: "Add feature",
        bodyFile: "/body",
      });
      expect(writes).toEqual([
        {
          title: "Add feature",
          description: "Description\nwith lines",
          source_branch: "feature",
          target_branch: "main",
          publish: true,
          fork_repo_id: "fork-id",
        },
      ]);
    }),
  );
});

it.effect("uses a custom frontend for PR links when its Git host is different", () =>
  Effect.gen(function* () {
    const provider = yield* setup(
      () => Effect.succeed(JSON.stringify(pull)),
      "https://code.example.test:8443",
      "git.example.test",
    );
    const customContext = {
      ...context,
      remoteUrl: "git@git.example.test:team/repo.git",
      provider: { ...context.provider, baseUrl: "https://code.example.test:8443" },
    };
    const result = yield* provider.getChangeRequest({
      cwd: "/repo",
      context: customContext,
      reference: "42",
    });
    expect(result.url).toBe("https://code.example.test:8443/team/repo/pr/42");
    const identity = yield* provider.refineRepositoryIdentity!({
      identity: {
        rootPath: "/repo",
        canonicalKey: "git.example.test/team/repo",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: customContext.remoteUrl },
      },
      resolveContext: () => Effect.succeed(customContext),
    });
    expect(identity).toMatchObject({
      provider: "sourcecraft",
      webUrl: "https://code.example.test:8443/team/repo",
    });
    expect(definition.changeRequestHost(identity)).toBe("code.example.test:8443");
    expect(
      yield* provider.resolveRemoteWebHost!({
        cwd: "/repo",
        context: customContext,
        resolveContext: () => Effect.succeed(customContext),
      }),
    ).toBe("code.example.test:8443");
  }),
);

it.effect("distinguishes an expired login from access and response errors", () =>
  Effect.gen(function* () {
    for (const sample of [
      { status: 401, reason: "unauthenticated" as const, expected: "src auth login" },
      { status: 403, reason: "failed" as const, expected: "denied access" },
      { status: 429, reason: "failed" as const, expected: "rate limit" },
    ]) {
      const provider = yield* setup(() =>
        Effect.fail(
          new SourceCraftCli.SourceCraftCliError({
            operation: "GET",
            status: sample.status,
            reason: sample.reason,
          }),
        ),
      );
      const result = yield* provider
        .getChangeRequest({ cwd: "/repo", context, reference: "42" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.detail).toContain(sample.expected);
        if (sample.status !== 401) expect(result.failure.detail).not.toContain("auth login");
      }
    }
    const provider = yield* setup(() => Effect.succeed('{"unexpected":true}'));
    const result = yield* provider
      .getChangeRequest({ cwd: "/repo", context, reference: "42" })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.detail).toContain("invalid response");
      expect(result.failure.detail).not.toContain("auth login");
    }
  }),
);
