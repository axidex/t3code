import { expect, it } from "vite-plus/test";
import { activity, commentAnchor, reviewDecision } from "./sourceCraftReview.ts";

it("groups replies across pages, prefers current resolution state and hides deleted drafts", () => {
  const base = { body: "text", created_at: "2026-01-01T00:00:00Z" };
  const result = activity([
    { ...base, id: "reply", parent_id: "root" },
    {
      ...base,
      id: "root",
      anchor: { path: "a.ts", position: { to: 7, side: "target" } },
      is_resolved: true,
      resolution_state: "awaiting_resolution",
      is_outdated: true,
    },
    { ...base, id: "general" },
    { ...base, id: "draft", is_published: false },
    { ...base, id: "deleted", is_deleted: true },
    { ...base, id: "orphan", parent_id: "missing" },
    { ...base, id: "cycle", parent_id: "cycle" },
  ]);
  expect(result.comments.map((c) => c.id)).toEqual(["general", "orphan", "cycle"]);
  expect(result.reviewThreads).toMatchObject([
    { id: "root", path: "a.ts", line: 7, side: "left", isResolved: false, isOutdated: true },
  ]);
  expect(result.reviewThreads[0]?.comments.map((c) => c.id).sort()).toEqual(["reply", "root"]);
});

it("maps same-side ranges, anchors mixed ranges at their end and rejects inverted ranges", () => {
  const draft = { path: "a.ts", body: "review" };
  expect(
    commentAnchor({
      ...draft,
      position: { kind: "deleted", oldLine: 9 },
      startPosition: { kind: "deleted", oldLine: 7 },
    }),
  ).toEqual({ path: "a.ts", position: { from: 7, to: 9, side: "target" } });
  expect(
    commentAnchor({
      ...draft,
      position: { kind: "context", side: "right", oldLine: 4, newLine: 6 },
    }),
  ).toMatchObject({ position: { from: 6, to: 6, side: "source" } });
  expect(
    commentAnchor({
      ...draft,
      position: { kind: "added", newLine: 9 },
      startPosition: { kind: "deleted", oldLine: 7 },
    }),
  ).toEqual({ path: "a.ts", position: { from: 9, to: 9, side: "source" } });
  expect(
    commentAnchor({
      ...draft,
      position: { kind: "deleted", oldLine: 9 },
      startPosition: { kind: "added", newLine: 17 },
    }),
  ).toEqual({ path: "a.ts", position: { from: 9, to: 9, side: "target" } });
  expect(
    commentAnchor({
      ...draft,
      position: { kind: "added", newLine: 3 },
      startPosition: { kind: "added", newLine: 7 },
    }),
  ).toBeNull();
});

it("keeps blocking reviews and unresolved checks ahead of approval counts", () => {
  const reviewer = { user: { id: "id", slug: "alice" }, review_decision: "block" };
  expect(
    reviewDecision([reviewer], { status: "success", need_approves: 1, total_approves: 2 }),
  ).toBe("changes-requested");
  expect(
    reviewDecision([{ ...reviewer, review_decision: "approve" }], {
      status: "failure",
      need_approves: 1,
      total_approves: 2,
    }),
  ).toBe("review-required");
  expect(
    reviewDecision([{ ...reviewer, review_decision: "approve" }], {
      status: "success",
      need_approves: 1,
      total_approves: 2,
    }),
  ).toBe("approved");
});
