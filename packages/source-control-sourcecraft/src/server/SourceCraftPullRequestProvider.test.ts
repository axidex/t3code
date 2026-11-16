import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Provider from "./SourceCraftPullRequestProvider.ts";
import * as Api from "./SourceCraftCli.ts";
const input = { cwd: "/repo", host: "sourcecraft.dev", repository: "team/repo", number: 42 };
const pull = {
  id: "uuid",
  slug: "42",
  title: "Feature",
  status: "merged",
  source: { ref: "feature", sha: "abc", label: "team/repo:feature" },
  target: { ref: "main", sha: "def", label: "team/repo:main" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

it.effect("keeps PR state separate from merge check readiness", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* provider.getChangeRequestChecks!(input);
    expect(result.state).toBe("merged");
    expect(result.checks).toEqual([
      { name: "Merge readiness", status: "success", description: null, url: null, required: true },
    ]);
  }).pipe(
    Effect.provideService(Api.SourceCraftCli, {
      environment: () =>
        Effect.succeed({
          name: "ExtProd",
          active: true,
          frontend: "https://sourcecraft.dev",
          git: "git.sourcecraft.dev",
        }),
      request: (request) =>
        Effect.succeed(
          JSON.stringify(
            request.path.endsWith("merge-checks")
              ? {
                  status: "success",
                  ci_workflows: [{ workflow_slug: "disabled", status: "failed", disabled: true }],
                }
              : pull,
          ),
        ),
    }),
  ),
);

it.effect("reads the asynchronous merge result without resubmitting the merge", () =>
  Effect.gen(function* () {
    const requests: Api.Request[] = [];
    const provider = yield* Provider.make.pipe(
      Effect.provideService(Api.SourceCraftCli, {
        environment: () =>
          Effect.succeed({
            name: "ExtProd",
            active: true,
            frontend: "https://sourcecraft.dev",
            git: "git.sourcecraft.dev",
          }),
        request: (request) => {
          requests.push(request);
          return Effect.succeed(
            JSON.stringify({
              operation_id: "operation-id",
              status: request.method === "POST" ? "scheduled" : "success",
            }),
          );
        },
      }),
    );
    yield* provider.runAction({ ...input, action: "merge", mergeMethod: "squash" });
    expect(requests.map((r) => [r.method ?? "GET", r.path])).toEqual([
      ["POST", "/repos/team/repo/pulls/42/merge"],
      ["GET", "/operations/merge/id:operation-id"],
    ]);
    expect(requests[0]?.body).toEqual({ rebase: false, squash: true, force: false });
  }),
);

it.effect("skips pages outside the selected state and exposes the continuation token", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make.pipe(
      Effect.provideService(Api.SourceCraftCli, {
        environment: () =>
          Effect.succeed({
            name: "ExtProd",
            active: true,
            frontend: "https://sourcecraft.dev",
            git: "git.sourcecraft.dev",
          }),
        request: (request) =>
          Effect.succeed(
            JSON.stringify(
              request.path.includes("page_token=next")
                ? { pull_requests: [{ ...pull, status: "draft" }], next_page_token: "last" }
                : { pull_requests: [pull], next_page_token: "next" },
            ),
          ),
      }),
    );
    const page = yield* provider.listChangeRequests({
      ...input,
      state: "open",
      involvement: "all",
      viewer: "alice",
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ state: "open", isDraft: true });
    expect(page).toMatchObject({ truncated: true, continues: true, resumeAfter: "last" });
  }),
);

it.effect(
  "reads paginated threads and reviewers and writes reviews through the selected CLI environment",
  () =>
    Effect.gen(function* () {
      const writes: Array<{ cwd: string; path: string; body: unknown }> = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          Api.layer.pipe(
            Layer.provide(
              TestHost.layer({
                process: {
                  run: (command) => {
                    expect(command.args).not.toContain("--env");
                    const host =
                      command.cwd === "/env-one" ? "one.example.test" : "two.example.test";
                    if (command.args[0] === "envs")
                      return Effect.succeed(
                        TestHost.processOutput(
                          JSON.stringify([
                            {
                              name: host,
                              active: true,
                              frontend: `https://${host}`,
                              git: `git.${host}`,
                            },
                          ]),
                        ),
                      );
                    const path = command.args[1]!;
                    const method = command.args[command.args.indexOf("--method") + 1];
                    if (method !== "GET") {
                      writes.push({ cwd: command.cwd, path, body: JSON.parse(command.stdin!) });
                      return Effect.succeed(
                        TestHost.processOutput("HTTP/2.0 204 No Content\r\n\r\n"),
                      );
                    }
                    const comment = { body: "body", created_at: "2026-01-01T00:00:00Z" };
                    const body = path.includes("/comments?")
                      ? path.includes("page_token=next")
                        ? {
                            pull_request_comments: [
                              {
                                ...comment,
                                id: "root",
                                anchor: { path: "a.ts", position: { to: 3, side: "source" } },
                                resolution_state: "resolved",
                              },
                            ],
                            next_page_token: null,
                          }
                        : {
                            pull_request_comments: [{ ...comment, id: "reply", parent_id: "root" }],
                            next_page_token: "next",
                          }
                      : path.includes("/reviewers?")
                        ? {
                            reviewers: [
                              {
                                user: { id: "alice-id", slug: "alice" },
                                review_decision: "approve",
                              },
                            ],
                          }
                        : path.endsWith("/merge-checks")
                          ? {
                              status: "success",
                              code_review: {
                                status: "success",
                                need_approves: 1,
                                total_approves: 1,
                              },
                            }
                          : path.includes("/files?")
                            ? { files: [] }
                            : pull;
                    return Effect.succeed(
                      TestHost.processOutput(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`),
                    );
                  },
                },
              }),
            ),
          ),
        ),
      );
      for (const name of ["one", "two"]) {
        const target = { ...input, cwd: `/env-${name}`, host: `${name}.example.test` };
        const activity = yield* provider.getChangeRequestActivity(target);
        expect(activity.reviewThreads).toMatchObject([
          { id: "root", isResolved: true, comments: [{ id: "reply" }, { id: "root" }] },
        ]);
        expect(activity.commentsTruncated).toBe(false);
        const detail = yield* provider.getChangeRequest(target);
        expect(detail.url).toBe(`https://${target.host}/team/repo/pr/42`);
        expect(detail.reviewers).toMatchObject([{ login: "alice" }]);
        expect(detail.reviewDecision).toBe("approved");
        yield* provider.submitReview({
          ...target,
          verdict: "approve",
          body: "",
          comments: [
            {
              path: "a.ts",
              position: { kind: "added", newLine: 5 },
              startPosition: { kind: "added", newLine: 3 },
              body: "inline",
            },
            {
              path: "a.ts",
              startPosition: { kind: "deleted", oldLine: 797 },
              position: { kind: "added", newLine: 801 },
              body: "mixed range",
            },
          ],
        });
        yield* provider.replyToThread({ ...target, threadId: "root", body: "reply" });
        yield* provider.updateComment!({
          ...target,
          commentId: "root",
          kind: "review-comment",
          body: "edited",
        });
        yield* provider.setThreadResolution({ ...target, threadId: "root", resolved: true });
        yield* provider.setThreadResolution({ ...target, threadId: "root", resolved: false });
        const own = writes.filter((w) => w.cwd === target.cwd);
        expect(own.map((w) => w.body)).toEqual([
          {
            body: "inline",
            anchor: { path: "a.ts", position: { from: 3, to: 5, side: "source" } },
            publish: true,
          },
          {
            body: "mixed range",
            anchor: { path: "a.ts", position: { from: 801, to: 801, side: "source" } },
            publish: true,
          },
          { review_decision: "approve" },
          { body: "reply", parent_id: "root", publish: true },
          { body: "edited" },
          { resolution_state: "awaiting_resolution" },
          { resolution_state: "resolved" },
          { resolution_state: "awaiting_resolution" },
        ]);
        expect(own[4]?.path).toBe("/pull_comments/id:root");
      }
      const before = writes.length;
      const rejected = yield* provider.updateComment!({
        ...input,
        cwd: "/env-two",
        host: "one.example.test",
        commentId: "root",
        kind: "review-comment",
        body: "wrong env",
      }).pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      expect(writes).toHaveLength(before);
    }),
);
