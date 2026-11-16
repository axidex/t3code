import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { type ChangeRequest, type PullRequestActor } from "@t3tools/contracts";
import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import { definition } from "../shared/definition.ts";

const Branch = Schema.Struct({ ref: Schema.String, sha: Schema.String, label: Schema.String });
export const User = Schema.Struct({ id: Schema.String, slug: Schema.String });
export const Pull = Schema.Struct({
  id: Schema.String,
  slug: Schema.String.check(Schema.isPattern(/^[1-9]\d{0,14}$/u)),
  title: Schema.String,
  repository: Schema.optional(
    Schema.Struct({ slug: Schema.String, organization: Schema.Struct({ slug: Schema.String }) }),
  ),
  description: Schema.optional(Schema.String),
  author: Schema.optional(User),
  status: Schema.Literals(["draft", "open", "discarded", "merging", "merged"]),
  source: Branch,
  target: Branch,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export const Pulls = Schema.Struct({
  pull_requests: Schema.Array(Pull),
  next_page_token: Schema.optional(Schema.String),
});
export const Repository = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  organization: Schema.Struct({ slug: Schema.String }),
  default_branch: Schema.optional(Schema.String),
  clone_url: Schema.Struct({ https: Schema.String, ssh: Schema.String }),
});
export const Profile = Schema.Struct({ id: Schema.String, username: Schema.String });
export const actor = (user: typeof User.Type | undefined): PullRequestActor | null =>
  user ? { login: user.slug, name: null, avatarUrl: null } : null;
export const sourceRepository = (pull: typeof Pull.Type) =>
  pull.source.label.slice(0, pull.source.label.indexOf(":"));
export function changeRequest(
  pull: typeof Pull.Type,
  repository: string,
  frontend: string,
): ChangeRequest {
  const number = Number(pull.slug);
  const source = sourceRepository(pull);
  return {
    provider: definition.kind,
    number,
    title: pull.title,
    url: definition.changeRequestUrl({
      host: new URL(frontend).host,
      repository,
      number,
      webUrl: `${frontend.replace(/\/$/u, "")}/${repository}`,
    }),
    baseRefName: pull.target.ref,
    headRefName: pull.source.ref,
    ...(pull.source.sha ? { headSha: pull.source.sha } : {}),
    state: pull.status === "merged" ? "merged" : pull.status === "discarded" ? "closed" : "open",
    isDraft: pull.status === "draft",
    updatedAt: DateTime.make(pull.updated_at),
    isCrossRepository: source !== repository,
    headRepositoryNameWithOwner: source || null,
    headRepositoryOwnerLogin: source.split("/")[0] || null,
  };
}
export function summary(
  pull: typeof Pull.Type,
  repository: string,
  frontend: string,
): ProviderChangeRequest {
  const value = changeRequest(pull, repository, frontend);
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    author: actor(pull.author),
    headBranch: value.headRefName,
    baseBranch: value.baseRefName,
    headRepositoryNameWithOwner: value.headRepositoryNameWithOwner ?? null,
    state: value.state,
    isDraft: value.isDraft ?? false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    reviewRequestLogins: [],
    labels: [],
  };
}
export const cloneUrls = (repo: typeof Repository.Type) => ({
  nameWithOwner: `${repo.organization.slug}/${repo.slug}`,
  url: repo.clone_url.https,
  sshUrl: repo.clone_url.ssh,
});
export const repositoryPath = (repository: string) =>
  `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
