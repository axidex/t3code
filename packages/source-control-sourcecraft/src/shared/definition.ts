import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  remoteWebOrigin,
  type ChangeRequestHostIdentity,
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
  repositoryUrlFromPagePath,
} from "@t3tools/source-control-core/shared/definition";

const KIND = SourceControlProviderKind.make("sourcecraft");
const isHost = (host: string) =>
  ["sourcecraft.dev", "git.sourcecraft.dev", "ssh.sourcecraft.dev"].includes(host.toLowerCase());
const projectHost = (identity: ChangeRequestHostIdentity) => {
  const web = identity?.webUrl && URL.parse(identity.webUrl);
  const host = web ? web.host : projectChangeRequestHost(identity, KIND);
  return isHost(host) ? "sourcecraft.dev" : host;
};
const parsePull = (url: URL) =>
  parseChangeRequestPath(url, /^\/([^/]+\/[^/]+)\/pr\/(\d+)(?:\/|$)/u);

export const definition = defineSourceControl({
  kind: KIND,
  label: "SourceCraft",
  pickerLabel: "SourceCraft",
  icon: {
    viewBox: "0 0 24 24",
    paths: [{ d: "M8 4 0 12l8 8 2-2-6-6 6-6Zm8 0-2 2 6 6-6 6 2 2 8-8Z", fill: "currentColor" }],
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "organization/repo",
  publicHost: "sourcecraft.dev",
  publishDescription: "SourceCraft CLI environment",
  publishHost: (signedInHost) => signedInHost ?? "SourceCraft CLI environment",
  newRepositoryOwner: () => ({ owner: null }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `pr/${number}`)
      : `${remoteWebOrigin(host, remoteUrl)}/${repository}/pr/${number}`,
  changeRequestHost: projectHost,
  parseChangeRequestUrl: parsePull,
  changeRequestUrlFromReferenceAutolink: () => null,
  commitUrl: (input) => buildCommitUrl(input, "commit"),
  parseCommitUrl: (url) =>
    isHost(url.host) ? parseCommitPath(url, /^\/([^/]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu) : null,
  repositoryUrlFromPage: (url) =>
    isHost(url.host)
      ? repositoryUrlFromPagePath(url, /^\/([^/]+\/[^/]+)\/(?:tree|blob)\/[^/]/u)
      : null,
  changeRequestActions: new Set(["ready", "draft", "close", "reopen", "merge"] as const),
  checkoutCommand: ({ number }) => `src pr checkout ${number}`,
  checkoutCommandArgument: (input) =>
    /^src\s+(?:--env\s+[^\s]+\s+)?pr\s+checkout\s+([1-9]\d*)(?:\s+--env\s+[^\s]+)?$/u.exec(
      input,
    )?.[1] ?? null,
  checkoutChangeRequestHost: () => null,
  changeRequestCloseCommand: /\bsrc\s+(?:--env\s+[^\s]+\s+)?pr\s+(?:merge|discard)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  isChangeRequestReference: (value) => {
    try {
      return parsePull(new URL(value)) !== null;
    } catch {
      return false;
    }
  },
  repositoryKeyFromRemote: (key) =>
    /^(?:git|ssh)\.sourcecraft\.dev\//iu.test(key) ? key.replace(/^(?:git|ssh)\./iu, "") : null,
  canonicalRepositoryKey: (key) =>
    /^(?:(?:git|ssh)\.)?sourcecraft\.dev\//iu.test(key)
      ? key.replace(/^(?:git|ssh)\./iu, "")
      : null,
  recognizeRemote: ({ hostname }) =>
    isHost(hostname)
      ? { kind: KIND, name: "SourceCraft", baseUrl: "https://sourcecraft.dev" }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectHost(identity), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectHost(identity), identity, link),
});
