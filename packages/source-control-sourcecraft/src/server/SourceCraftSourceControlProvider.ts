import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceCraftCli from "./SourceCraftCli.ts";
import * as Json from "./sourceCraftJson.ts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { definition } from "../shared/definition.ts";

const isCliError = Schema.is(SourceCraftCli.SourceCraftCliError);
const encodeBranch = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

export const make = Effect.gen(function* () {
  const api = yield* SourceCraftCli.SourceCraftCli;
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const failure = (operation: string, cwd: string, cause?: unknown, detail?: string) =>
    new SourceControlProviderError({
      provider: definition.kind,
      operation,
      cwd,
      detail:
        detail ??
        (isCliError(cause)
          ? `${cause.message}${cause.reason === "unauthenticated" ? ` Project directory: ${cwd}.` : ""}`
          : "SourceCraft operation failed. Check the repository configuration."),
      cause,
    });
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    cwd: string,
    input: Omit<SourceCraftCli.Request, "cwd">,
    schema: S,
  ) =>
    api.request({ ...input, cwd }).pipe(
      Effect.mapError((cause) => failure("request", cwd, cause)),
      Effect.flatMap((body) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
          Effect.mapError((cause) =>
            failure(
              "decode",
              cwd,
              cause,
              "SourceCraft returned an invalid response. This is an integration or API compatibility error.",
            ),
          ),
        ),
      ),
    );
  const resolve = Effect.fn("SourceCraftSourceControlProvider.resolve")(function* (input: {
    cwd: string;
    context?: SourceControlProvider.SourceControlProviderContext;
    repository?: string;
    host?: string;
  }) {
    const environment = yield* api
      .environment(input.cwd)
      .pipe(Effect.mapError((cause) => failure("resolve", input.cwd, cause)));
    if (input.host && !SourceCraftCli.matchesEnvironment(environment, input.host))
      return yield* failure("resolve", input.cwd);
    if (input.repository) {
      if (!/^[^/\s]+\/[^/\s]+$/u.test(input.repository))
        return yield* failure("resolve", input.cwd);
      return { repository: input.repository, frontend: environment.frontend };
    }
    const remote =
      input.context?.remoteUrl ??
      (yield* host.git
        .execute({
          operation: "SourceCraft.remote",
          cwd: input.cwd,
          args: ["remote", "get-url", "origin"],
        })
        .pipe(
          Effect.map((r) => r.stdout.trim()),
          Effect.mapError((cause) => failure("resolve", input.cwd, cause)),
        ));
    const remoteHost = parseGitRemoteHost(remote);
    if (!remoteHost || !SourceCraftCli.matchesEnvironment(environment, remoteHost.host))
      return yield* failure("resolve", input.cwd);
    const repository = SourceControlProvider.repositoryPathFromRemoteUrl(remote);
    if (!repository || !/^[^/\s]+\/[^/\s]+$/u.test(repository))
      return yield* failure("resolve", input.cwd);
    return { repository, frontend: environment.frontend };
  });
  const getPull = Effect.fn("SourceCraftSourceControlProvider.getPull")(function* (input: {
    cwd: string;
    context?: SourceControlProvider.SourceControlProviderContext;
    reference: string;
  }) {
    const url = URL.parse(input.reference);
    const link = url ? definition.parseChangeRequestUrl(url) : null;
    const number =
      link?.number ??
      (/^#?[1-9]\d*$/u.test(input.reference) ? Number(input.reference.replace(/^#/u, "")) : null);
    if (!number || !Number.isSafeInteger(number))
      return yield* failure("getChangeRequest", input.cwd);
    const { repository, frontend } = yield* resolve({
      ...input,
      ...(link ? { repository: link.repository, host: link.authority ?? link.host } : {}),
    });
    const pull = yield* read(
      input.cwd,
      { path: `${Json.repositoryPath(repository)}/pulls/${number}` },
      Json.Pull,
    );
    return { repository, pull, frontend };
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind: definition.kind,
    refineRepositoryIdentity: Effect.fn(
      "SourceCraftSourceControlProvider.refineRepositoryIdentity",
    )(function* ({ identity, resolveContext }) {
      if (
        !identity.rootPath ||
        (identity.provider !== undefined &&
          identity.provider !== "unknown" &&
          identity.provider !== definition.kind)
      )
        return identity;
      const context = yield* resolveContext({
        cwd: identity.rootPath,
        context: {
          provider: {
            kind: SourceControlProviderKind.make("unknown"),
            name: "Unknown",
            baseUrl: "",
          },
          remoteName: identity.locator.remoteName,
          remoteUrl: identity.locator.remoteUrl,
        },
      });
      const repository = SourceControlProvider.repositoryPathFromRemoteUrl(
        identity.locator.remoteUrl,
      );
      if (context?.provider.kind !== definition.kind || !repository) return identity;
      return {
        ...identity,
        provider: definition.kind,
        webUrl: `${context.provider.baseUrl.replace(/\/$/u, "")}/${repository}`,
      };
    }),
    resolveRemoteWebHost: Effect.fn("SourceCraftSourceControlProvider.resolveRemoteWebHost")(
      function* (input) {
        const { frontend } = yield* resolve(input);
        return new URL(frontend).host;
      },
    ),
    getChangeRequest: Effect.fn("SourceCraftSourceControlProvider.getChangeRequest")(
      function* (input) {
        const { repository, pull, frontend } = yield* getPull(input);
        return Json.changeRequest(pull, repository, frontend);
      },
    ),
    listChangeRequests: Effect.fn("SourceCraftSourceControlProvider.listChangeRequests")(
      function* (input) {
        const { repository, frontend } = yield* resolve(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const quotedBranch = yield* encodeBranch(branch).pipe(
          Effect.mapError((cause) => failure("listChangeRequests", input.cwd, cause)),
        );
        const results: ReturnType<typeof Json.changeRequest>[] = [];
        const seen = new Set<string>();
        let token = "";
        do {
          const query = new URLSearchParams({
            page_size: "100",
            sort_by: "-updated_at",
            filter: `source_branch=${quotedBranch}`,
            ...(token ? { page_token: token } : {}),
          });
          const page = yield* read(
            input.cwd,
            { path: `${Json.repositoryPath(repository)}/pulls?${query}` },
            Json.Pulls,
          );
          for (const pull of page.pull_requests) {
            const value = Json.changeRequest(pull, repository, frontend);
            if (
              value.headRefName === branch &&
              (input.state === "all" || value.state === input.state) &&
              (!source?.repository || value.headRepositoryNameWithOwner === source.repository) &&
              (!source?.owner || value.headRepositoryOwnerLogin === source.owner)
            )
              results.push(value);
          }
          token = page.next_page_token ?? "";
          if (token && seen.has(token)) return yield* failure("listChangeRequests", input.cwd);
          seen.add(token);
        } while (token && results.length < (input.limit ?? 20));
        return results.slice(0, input.limit ?? 20);
      },
    ),
    createChangeRequest: Effect.fn("SourceCraftSourceControlProvider.createChangeRequest")(
      function* (input) {
        const { repository } = yield* resolve({
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const sourceRepository =
          source?.repository ??
          (source?.owner ? `${source.owner}/${repository.split("/")[1]}` : repository);
        const fork =
          sourceRepository === repository
            ? undefined
            : yield* read(
                input.cwd,
                { path: Json.repositoryPath(sourceRepository) },
                Json.Repository,
              );
        const description = yield* fs
          .readFileString(input.bodyFile)
          .pipe(Effect.mapError((cause) => failure("createChangeRequest", input.cwd, cause)));
        yield* read(
          input.cwd,
          {
            path: `${Json.repositoryPath(repository)}/pulls`,
            method: "POST",
            body: {
              title: input.title,
              description,
              source_branch: SourceControlProvider.sourceBranch(input),
              target_branch: input.target?.refName ?? input.baseRefName,
              publish: true,
              ...(fork ? { fork_repo_id: fork.id } : {}),
            },
          },
          Json.Pull,
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("SourceCraftSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const { repository } = yield* resolve(input);
        return Json.cloneUrls(
          yield* read(input.cwd, { path: Json.repositoryPath(repository) }, Json.Repository),
        );
      },
    ),
    createRepository: Effect.fn("SourceCraftSourceControlProvider.createRepository")(
      function* (input) {
        const { repository } = yield* resolve(input);
        const [owner, slug] = repository.split("/");
        return Json.cloneUrls(
          yield* read(
            input.cwd,
            {
              path: `/orgs/${encodeURIComponent(owner!)}/repos`,
              method: "POST",
              body: { slug, visibility: input.visibility },
            },
            Json.Repository,
          ),
        );
      },
    ),
    getDefaultBranch: Effect.fn("SourceCraftSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const { repository } = yield* resolve(input);
        return (
          (yield* read(input.cwd, { path: Json.repositoryPath(repository) }, Json.Repository))
            .default_branch || null
        );
      },
    ),
    checkoutChangeRequest: Effect.fn("SourceCraftSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const { pull, repository } = yield* getPull(input);
        const source = Json.sourceRepository(pull) || repository;
        const repo = yield* read(input.cwd, { path: Json.repositoryPath(source) }, Json.Repository);
        yield* Effect.gen(function* () {
          const remoteName = yield* host.git.ensureRemote({
            cwd: input.cwd,
            preferredName: "sourcecraft",
            url: input.context?.remoteUrl.startsWith("git@")
              ? repo.clone_url.ssh
              : repo.clone_url.https,
          });
          const localBranch =
            source === repository ? pull.source.ref : `pr-${pull.slug}/${pull.source.ref}`;
          const remote = { cwd: input.cwd, remoteName, remoteBranch: pull.source.ref };
          const branches = yield* host.git.listLocalBranchNames(input.cwd);
          if (!input.force && !branches.includes(localBranch))
            yield* host.git.fetchRemoteBranch({ ...remote, localBranch });
          else yield* host.git.fetchRemoteTrackingBranch(remote);
          if (input.force)
            yield* host.git.execute({
              operation: "SourceCraft.checkout",
              cwd: input.cwd,
              args: [
                "checkout",
                "--no-track",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${pull.source.ref}`,
                "--",
              ],
            });
          yield* host.git.setBranchUpstream({ ...remote, branch: localBranch });
          yield* Effect.scoped(host.git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(Effect.mapError((cause) => failure("checkoutChangeRequest", input.cwd, cause)));
      },
    ),
  });
});
