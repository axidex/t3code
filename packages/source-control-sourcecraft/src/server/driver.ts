import * as Effect from "effect/Effect";
import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import { definition } from "../shared/definition.ts";
import * as SourceCraftCli from "./SourceCraftCli.ts";
import * as SourceCraftSourceControlProvider from "./SourceCraftSourceControlProvider.ts";
import * as SourceCraftPullRequestProvider from "./SourceCraftPullRequestProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(
    Effect.all({
      sourceControl: SourceCraftSourceControlProvider.make,
      discovery: SourceCraftCli.makeDiscovery,
      pullRequests: SourceCraftPullRequestProvider.make,
    }),
    SourceCraftCli.layer,
  ),
});
