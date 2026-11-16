import { expect, it } from "vite-plus/test";
import { definition } from "./definition.ts";

it("recognizes SourceCraft PR routes on custom hosts", () => {
  expect(definition.repositoryKeyFromRemote("ssh.sourcecraft.dev/team/repo")).toBe(
    "sourcecraft.dev/team/repo",
  );
  expect(definition.canonicalRepositoryKey("git.sourcecraft.dev/team/repo")).toBe(
    "sourcecraft.dev/team/repo",
  );
  expect(definition.canonicalRepositoryKey("ssh.custom.test/team/repo")).toBeNull();
  expect(
    definition.recognizeRemote({
      remoteUrl: "ssh://ssh.sourcecraft.dev/team/repo.git",
      host: "ssh.sourcecraft.dev",
      hostname: "ssh.sourcecraft.dev",
    })?.kind,
  ).toBe("sourcecraft");
  expect(
    definition.parseChangeRequestUrl(new URL("https://sourcecraft.dev/team/repo/pr/42?tab=files")),
  ).toMatchObject({ repository: "team/repo", number: 42, host: "sourcecraft.dev" });
  expect(
    definition.parseChangeRequestUrl(new URL("https://code.example.test/team/repo/pr/42")),
  ).toMatchObject({ host: "code.example.test", number: 42 });
  expect(
    definition.parseChangeRequestUrl(new URL("https://sourcecraft.dev/team/repo/pulls/42")),
  ).toBeNull();
});

it("reads checkout commands without overriding the CLI environment", () => {
  for (const command of [
    "src pr checkout 42",
    "src pr checkout 42 --env ExtProd",
    "src --env ExtProd pr checkout 42",
    "src --env Custom pr checkout 42",
  ]) {
    expect(definition.checkoutCommandArgument(command)).toBe("42");
  }
  expect(definition.checkoutCommand({ number: 42, headBranch: "feature" })).toBe(
    "src pr checkout 42",
  );
});
