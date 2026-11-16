import type {
  PullRequestComment,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { User, actor } from "./sourceCraftJson.ts";

export const Comment = Schema.Struct({
  id: Schema.String,
  body: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(User)),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  is_deleted: Schema.optional(Schema.Boolean),
  is_published: Schema.optional(Schema.Boolean),
  is_resolved: Schema.optional(Schema.Boolean),
  resolution_state: Schema.optional(Schema.String),
  is_outdated: Schema.optional(Schema.Boolean),
  anchor: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.String,
        position: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              to: Schema.optional(Schema.Number),
              side: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});
export const Comments = Schema.Struct({
  pull_request_comments: Schema.optional(Schema.NullOr(Schema.Array(Comment))),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
});
export const Reviewer = Schema.Struct({
  user: User,
  review_decision: Schema.optional(Schema.NullOr(Schema.String)),
});
export const Reviewers = Schema.Struct({
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
});

const position = (value: PullRequestReviewPosition) =>
  value.kind === "deleted" || (value.kind === "context" && value.side === "left")
    ? { side: "target", line: value.oldLine }
    : { side: "source", line: value.newLine };
export function commentAnchor(draft: PullRequestReviewCommentDraft) {
  const end = position(draft.position);
  const start = draft.startPosition ? position(draft.startPosition) : end;
  // SourceCraft ranges have only one side; mixed selections anchor to their last line.
  if (start.side !== end.side)
    return { path: draft.path, position: { from: end.line, to: end.line, side: end.side } };
  if (start.line > end.line) return null;
  return { path: draft.path, position: { from: start.line, to: end.line, side: end.side } };
}

export function activity(raw: ReadonlyArray<typeof Comment.Type>) {
  const visible = raw.filter((c) => !c.is_deleted && c.is_published !== false);
  const indexed = new Map(visible.map((c) => [c.id, c]));
  const groups = new Map<string, Array<typeof Comment.Type>>();
  const comments: PullRequestComment[] = [];
  const toComment = (c: typeof Comment.Type) => ({
    id: c.id,
    author: actor(c.author ?? undefined),
    body: c.body ?? "",
    createdAt: c.created_at,
    editedAt: c.updated_at && c.updated_at !== c.created_at ? c.updated_at : null,
    url: null,
  });
  for (const c of visible) {
    let root = c;
    const visited = new Set([c.id]);
    while (root.parent_id && indexed.has(root.parent_id) && !visited.has(root.parent_id)) {
      visited.add(root.parent_id);
      root = indexed.get(root.parent_id)!;
    }
    if (root.anchor?.path) {
      const group = groups.get(root.id) ?? [];
      group.push(c);
      groups.set(root.id, group);
    } else comments.push({ ...toComment(c), kind: "issue-comment", path: null, reviewState: null });
  }
  const reviewThreads: PullRequestReviewThread[] = [];
  for (const [id, entries] of groups) {
    const root = indexed.get(id)!;
    const line = root.anchor?.position?.to;
    reviewThreads.push({
      id,
      path: root.anchor!.path,
      line: line && Number.isSafeInteger(line) && line > 0 ? line : null,
      side: root.anchor?.position?.side === "target" ? "left" : "right",
      isResolved:
        root.resolution_state === undefined
          ? root.is_resolved === true
          : root.resolution_state === "resolved",
      isOutdated: root.is_outdated === true,
      comments: entries.toSorted((a, b) => a.created_at.localeCompare(b.created_at)).map(toComment),
    });
  }
  return {
    comments: comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    reviewThreads,
  };
}

export function reviewDecision(
  reviewers: ReadonlyArray<typeof Reviewer.Type>,
  check:
    | {
        status?: string | undefined;
        need_approves?: number | undefined;
        total_approves?: number | undefined;
      }
    | null
    | undefined,
) {
  if (reviewers.some((r) => r.review_decision === "block")) return "changes-requested" as const;
  const needed = check?.need_approves ?? 0;
  const approved = reviewers.some(
    (r) => r.review_decision === "approve" || r.review_decision === "trust",
  );
  if (!needed && !approved) return null;
  return check?.status === "success" && (check.total_approves ?? 0) >= needed
    ? ("approved" as const)
    : ("review-required" as const);
}
