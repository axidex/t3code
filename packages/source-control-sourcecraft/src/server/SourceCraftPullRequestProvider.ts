import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { definition } from "../shared/definition.ts";
import * as SourceCraftCli from "./SourceCraftCli.ts";
import * as Json from "./sourceCraftJson.ts";
import * as Review from "./sourceCraftReview.ts";

const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: false,
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: false, listCandidates: false, searchCandidates: false },
  edit: { changeRequest: true, comment: true },
};
const permissions: PullRequestViewerPermissions = {
  actions: capabilities.actions,
  comment: true,
  resolve: true,
  verdicts: capabilities.review.verdicts,
  requestReviewers: false,
  editChangeRequest: true,
};
const MergeOperation = Schema.Struct({
  operation_id: Schema.String,
  status: Schema.Literals(["scheduled", "in_progress", "success", "failed", "cancel"]),
});
const Checks = Schema.Struct({
  code_review: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        status: Schema.optional(Schema.String),
        total_approves: Schema.optional(Schema.Number),
        need_approves: Schema.optional(Schema.Number),
      }),
    ),
  ),
  status: Schema.Literals(["in_progress", "success", "failure"]),
  conflicts: Schema.optional(Schema.Struct({ status: Schema.String })),
  ci_workflows: Schema.optional(
    Schema.Array(
      Schema.Struct({
        workflow_slug: Schema.String,
        status: Schema.String,
        disabled: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
const Files = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      additions: Schema.optional(Schema.NumberFromString),
      deletions: Schema.optional(Schema.NumberFromString),
      filename: Schema.String,
      previous_filename: Schema.optional(Schema.String),
      status: Schema.String,
      patch: Schema.optional(Schema.String),
      patch_error: Schema.optional(Schema.Unknown),
    }),
  ),
  next_page_token: Schema.optional(Schema.String),
});
const pullPath = (input: ProviderRepositoryRef & { number: number }) =>
  `${Json.repositoryPath(input.repository)}/pulls/${input.number}`;

export const make = Effect.gen(function* () {
  const api = yield* SourceCraftCli.SourceCraftCli;
  const request = (input: { host?: string } & SourceCraftCli.Request) =>
    api.request(input).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: definition.kind,
            operation: input.method ?? "GET",
            reason:
              cause.reason === "missing-tool"
                ? "missing-tool"
                : cause.reason === "unauthenticated"
                  ? "unauthenticated"
                  : cause.status === 403
                    ? "forbidden"
                    : cause.status === 404
                      ? "not-found"
                      : cause.status === 429
                        ? "rate-limited"
                        : "failed",
            detail: cause.message,
            cause,
          }),
      ),
    );
  const environment = (cwd: string) =>
    api.environment(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: definition.kind,
            operation: "environment",
            reason: cause.reason,
            detail: cause.message,
            cause,
          }),
      ),
    );
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    input: { host?: string } & SourceCraftCli.Request,
    schema: S,
  ) =>
    request(input).pipe(
      Effect.flatMap((value) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(value).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: definition.kind,
                operation: "decode",
                reason: "failed",
                detail: "SourceCraft returned an invalid response.",
                cause,
              }),
          ),
        ),
      ),
    );
  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: definition.kind,
        operation,
        reason: "failed",
        detail: "This operation is not supported by the SourceCraft integration.",
      }),
    );
  const write = (input: { host?: string } & SourceCraftCli.Request) =>
    request(input).pipe(Effect.asVoid);
  const readPages = Effect.fn("SourceCraftPullRequestProvider.readPages")(function* <
    S extends Schema.Codec<
      { readonly next_page_token?: string | null | undefined },
      unknown,
      never,
      never
    >,
  >(input: SourceCraftCli.Request, schema: S) {
    const pages: S["Type"][] = [];
    const seen = new Set<string>();
    let token = "";
    do {
      const query = new URLSearchParams({
        page_size: "100",
        ...(token ? { page_token: token } : {}),
      });
      const page = yield* read({ ...input, path: `${input.path}?${query}` }, schema);
      pages.push(page);
      token = page.next_page_token ?? "";
      if (token && (seen.has(token) || pages.length >= 100)) return { pages, truncated: true };
      seen.add(token);
    } while (token);
    return { pages, truncated: false };
  });
  const getReviewers = (input: ProviderRepositoryRef & { number: number }) =>
    readPages({ ...input, path: `${pullPath(input)}/reviewers` }, Review.Reviewers).pipe(
      Effect.map((result) => ({
        entries: result.pages.flatMap((page) => page.reviewers ?? []),
        truncated: result.truncated,
      })),
    );
  const updateComment = (input: ProviderRepositoryRef, id: string, body: unknown) =>
    write({ ...input, path: `/pull_comments/id:${encodeURIComponent(id)}`, method: "PATCH", body });
  const getChecks = (input: ProviderRepositoryRef & { number: number }) =>
    read({ ...input, path: `${pullPath(input)}/merge-checks` }, Checks);
  const checks = (value: typeof Checks.Type) => [
    {
      name: "Merge readiness",
      status: value.status === "in_progress" ? ("pending" as const) : value.status,
      description: null,
      url: null,
      required: true,
    },
    ...(value.ci_workflows ?? [])
      .filter((c) => !c.disabled)
      .map((c) => ({
        name: c.workflow_slug,
        status:
          c.status === "success"
            ? ("success" as const)
            : ["failed", "timeout"].includes(c.status)
              ? ("failure" as const)
              : c.status === "canceled"
                ? ("cancelled" as const)
                : c.status === "skipped"
                  ? ("skipped" as const)
                  : ("pending" as const),
        description: null,
        url: null,
      })),
  ];
  const fileStats = Effect.fn("SourceCraftPullRequestProvider.fileStats")(function* (
    input: ProviderRepositoryRef & { number: number },
  ) {
    const files: Array<{ path: string; additions: number; deletions: number }> = [];
    const seen = new Set<string>();
    let token = "";
    do {
      const query = new URLSearchParams({
        page_size: "100",
        ...(token ? { page_token: token } : {}),
      });
      const page = yield* read({ ...input, path: `${pullPath(input)}/files?${query}` }, Files);
      files.push(
        ...page.files.map((file) => ({
          path: file.filename,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        })),
      );
      token = page.next_page_token ?? "";
      if (token && (seen.has(token) || seen.size >= 100))
        return yield* new PullRequestProviderError({
          provider: definition.kind,
          operation: "files",
          reason: "failed",
          detail: "SourceCraft file listing exceeded the page limit.",
        });
      seen.add(token);
    } while (token);
    return { files, truncated: false };
  });
  const provider: PullRequestProviderApi = {
    kind: definition.kind,
    capabilities,
    unavailableRequirement: {
      missing: "Install SourceCraft CLI (`src`) on the server.",
      unauthenticated: "Run `src auth login` in the project directory on the server.",
    },
    getViewer: (input) =>
      read({ ...input, path: "/user" }, Json.Profile).pipe(Effect.map((p) => p.username)),
    listChangeRequests: Effect.fn("SourceCraftPullRequestProvider.listChangeRequests")(
      function* (input) {
        const { frontend } = yield* environment(input.cwd);
        const query = new URLSearchParams({
          page_size: String(Math.min(100, Math.max(1, input.limit))),
          sort_by: "-updated_at",
          ...(input.cursor?.resumeAfter ? { page_token: input.cursor.resumeAfter } : {}),
        });
        if (input.involvement === "reviewing") query.set("role", "reviewer");
        const path =
          input.involvement === "reviewing"
            ? "/me/pulls"
            : `${Json.repositoryPath(input.repository)}/pulls`;
        const seen = new Set<string>();
        for (;;) {
          const page = yield* read({ ...input, path: `${path}?${query}` }, Json.Pulls);
          const items = page.pull_requests
            .filter(
              (p) =>
                input.involvement !== "reviewing" ||
                (p.repository &&
                  `${p.repository.organization.slug}/${p.repository.slug}` === input.repository),
            )
            .map((p) => ({
              ...Json.summary(p, input.repository, frontend),
              ...(input.involvement === "reviewing" ? { reviewRequestLogins: [input.viewer] } : {}),
            }))
            .filter(
              (p) =>
                (input.state === "all" || p.state === input.state) &&
                (input.involvement !== "authored" ||
                  p.author?.login.toLowerCase() === input.viewer.toLowerCase()),
            );
          const token = page.next_page_token;
          if (items.length || !token)
            return {
              items,
              truncated: Boolean(token),
              continues: Boolean(token),
              ...(token ? { resumeAfter: token } : {}),
            };
          if (seen.has(token) || seen.size >= 100)
            return yield* new PullRequestProviderError({
              provider: definition.kind,
              operation: "list",
              reason: "failed",
              detail:
                "SourceCraft listing exceeded the page limit. Narrow the selection and retry.",
            });
          seen.add(token);
          query.set("page_token", token);
        }
      },
    ),
    getChangeRequest: Effect.fn("SourceCraftPullRequestProvider.getChangeRequest")(
      function* (input) {
        const { frontend } = yield* environment(input.cwd);
        const [pull, status, stats, reviewers] = yield* Effect.all(
          [
            read({ ...input, path: pullPath(input) }, Json.Pull),
            getChecks(input),
            fileStats(input),
            getReviewers(input),
          ],
          { concurrency: 2 },
        );
        return {
          ...Json.summary(pull, input.repository, frontend),
          headSha: pull.source.sha,
          body: pull.description ?? "",
          changedFiles: stats.files.length,
          additions: stats.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: stats.files.reduce((sum, file) => sum + file.deletions, 0),
          mergedAt: null,
          closedAt: null,
          reviewers: reviewers.entries.map((r) => Json.actor(r.user)!),
          reviewRequestLogins: reviewers.entries
            .filter((r) => !r.review_decision || r.review_decision === "none")
            .map((r) => r.user.slug),
          reviewDecision: reviewers.truncated
            ? null
            : Review.reviewDecision(reviewers.entries, status.code_review),
          checks: checks(status),
          mergeability:
            status.conflicts?.status === "success"
              ? "mergeable"
              : status.conflicts?.status === "failure"
                ? "conflicting"
                : "unknown",
          mergeCapabilities: { merge: true, squash: true, rebase: true, "fast-forward": false },
          viewerPermissions: permissions,
        };
      },
    ),
    getFileStats: fileStats,
    getViewerPermissions: () => Effect.succeed(permissions),
    getChangeRequestChecks: (input) =>
      Effect.all([getChecks(input), read({ ...input, path: pullPath(input) }, Json.Pull)], {
        concurrency: 2,
      }).pipe(
        Effect.map(([value, pull]) => ({
          state: Json.changeRequest(pull, input.repository, `https://${input.host}`).state,
          checks: checks(value),
        })),
      ),
    getChangeRequestActivity: Effect.fn("SourceCraftPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const [pages, reviewers] = yield* Effect.all(
          [
            readPages({ ...input, path: `${pullPath(input)}/comments` }, Review.Comments),
            getReviewers(input),
          ],
          { concurrency: 2 },
        );
        const activity = Review.activity(
          pages.pages.flatMap((page) => page.pull_request_comments ?? []),
        );
        return {
          ...activity,
          commentCount: activity.comments.length,
          commentsTruncated: pages.truncated,
          commits: [],
          reviewers: reviewers.entries.map((r) => Json.actor(r.user)!),
        };
      },
    ),
    getDiff: Effect.fn("SourceCraftPullRequestProvider.getDiff")(function* (input) {
      if (input.commit) return yield* unsupported("commit diff");
      const query = new URLSearchParams({
        page_size: "100",
        ...(input.cursor ? { page_token: input.cursor } : {}),
      });
      const page = yield* read({ ...input, path: `${pullPath(input)}/files?${query}` }, Files);
      const patch = page.files
        .map((file) => {
          const old = file.previous_filename || file.filename;
          const quote = (path: string) => JSON.stringify(path);
          return `diff --git ${quote(`a/${old}`)} ${quote(`b/${file.filename}`)}\n--- ${file.status === "added" ? "/dev/null" : quote(`a/${old}`)}\n+++ ${file.status === "removed" ? "/dev/null" : quote(`b/${file.filename}`)}\n${file.patch ?? ""}\n`;
        })
        .join("");
      return {
        patch,
        truncated: page.files.some((f) => Boolean(f.patch_error) || !f.patch),
        nextCursor: page.next_page_token || null,
      };
    }),
    runAction: (input) => {
      if (input.action === "merge")
        return Effect.gen(function* () {
          if (input.mergeMethod === "fast-forward") return yield* unsupported("fast-forward merge");
          const operation = yield* read(
            {
              ...input,
              path: `${pullPath(input)}/merge`,
              method: "POST",
              body: {
                rebase: input.mergeMethod === "rebase",
                squash: input.mergeMethod === "squash",
                force: false,
              },
            },
            MergeOperation,
          );
          const terminal = (value: typeof MergeOperation.Type) =>
            !["scheduled", "in_progress"].includes(value.status);
          const result = terminal(operation)
            ? operation
            : yield* read(
                {
                  ...input,
                  path: `/operations/merge/id:${encodeURIComponent(operation.operation_id)}`,
                },
                MergeOperation,
              ).pipe(
                Effect.repeat({ until: terminal, schedule: Schedule.spaced("1 second") }),
                Effect.timeout("60 seconds"),
                Effect.mapError(
                  (cause) =>
                    new PullRequestProviderError({
                      provider: definition.kind,
                      operation: "merge",
                      reason: "failed",
                      detail:
                        "Could not confirm the SourceCraft merge result. Refresh the pull request before retrying.",
                      cause,
                    }),
                ),
              );
          if (result.status !== "success")
            return yield* new PullRequestProviderError({
              provider: definition.kind,
              operation: "merge",
              reason: "failed",
              detail:
                "SourceCraft did not complete the merge. Check merge requirements on SourceCraft.",
            });
        });
      const action = { ready: "publish", draft: "draft", close: "discard", reopen: "reopen" }[
        input.action as "ready" | "draft" | "close" | "reopen"
      ];
      return action
        ? write({ ...input, path: `${pullPath(input)}/${action}`, method: "POST", body: {} })
        : unsupported(input.action);
    },
    updateChangeRequest: (input) =>
      write({
        ...input,
        path: pullPath(input),
        method: "PATCH",
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        },
      }),
    comment: (input) =>
      write({
        ...input,
        path: `${pullPath(input)}/comments`,
        method: "POST",
        body: { body: input.body, publish: true },
      }),
    submitReview: Effect.fn("SourceCraftPullRequestProvider.submitReview")(function* (input) {
      const anchors = input.comments.map(Review.commentAnchor);
      if (anchors.some((anchor) => anchor === null))
        return yield* new PullRequestProviderError({
          provider: definition.kind,
          operation: "submitReview",
          reason: "failed",
          detail: "A review comment's range ends before it starts. Select the range again.",
        });
      for (const [index, comment] of input.comments.entries())
        yield* write({
          ...input,
          path: `${pullPath(input)}/comments`,
          method: "POST",
          body: { body: comment.body, anchor: anchors[index], publish: true },
        });
      if (input.body.trim()) yield* provider.comment(input);
      if (input.verdict !== "comment")
        yield* write({
          ...input,
          path: `${pullPath(input)}/decision`,
          method: "POST",
          body: { review_decision: input.verdict === "approve" ? "approve" : "block" },
        });
    }),
    listReviewerCandidates: () => unsupported("reviewer candidates"),
    setReviewerRequest: () => unsupported("request reviewers"),
    updateComment: (input) => updateComment(input, input.commentId, { body: input.body }),
    replyToThread: (input) =>
      write({
        ...input,
        path: `${pullPath(input)}/comments`,
        method: "POST",
        body: { body: input.body, parent_id: input.threadId, publish: true },
      }),
    setReaction: () => unsupported("reaction"),
    setThreadResolution: Effect.fn("SourceCraftPullRequestProvider.setThreadResolution")(
      function* (input) {
        // SourceCraft requires awaiting_resolution before resolving a comment that never needed it.
        yield* updateComment(input, input.threadId, { resolution_state: "awaiting_resolution" });
        if (input.resolved)
          yield* updateComment(input, input.threadId, { resolution_state: "resolved" });
      },
    ),
  };
  return provider;
});
