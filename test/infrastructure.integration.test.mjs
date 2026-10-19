import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Bicep defines the isolated secretless canary resources and mandatory alert target", async () => {
  const [source, tenant] = await Promise.all([
    readFile(new URL("../infra/main.bicep", import.meta.url), "utf8"),
    readFile(new URL("../infra/tenant.bicep", import.meta.url), "utf8"),
  ]);

  for (const required of [
    "Microsoft.Web/serverfarms@2024-04-01",
    "FlexConsumption",
    "Microsoft.Web/sites@2024-04-01",
    "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31",
    "Microsoft.Storage/storageAccounts@2023-05-01",
    "Microsoft.Insights/components@2020-02-02",
    "Microsoft.OperationalInsights/workspaces@2023-09-01",
    "Microsoft.Insights/actionGroups@2021-09-01",
    "Microsoft.Insights/scheduledQueryRules@2023-12-01",
    "version: '22'",
    "actionGroups: [actionGroup.id]",
    "emailAddress: alertEmailAddress",
    "managedIdentityPrincipalId",
    "name: watermarkContainerName",
    "param searchIndexOverlapMinutes int = 1440",
  ]) {
    assert.equal(source.includes(required), true, `missing infrastructure declaration: ${required}`);
  }

  for (const forbidden of [
    "listKeys(",
    "clientSecret",
    "User.Read.All",
    "recording-permission-retries",
    "Storage Queue Data Contributor",
    "Storage Table Data Contributor",
  ])
    assert.equal(source.includes(forbidden), false, `infrastructure includes forbidden state: ${forbidden}`);

  for (const template of [source, tenant]) {
    assert.match(template, /@maxLength\(4\)\s+param microsoftSearchRegion string/);
  }
});

test("Function telemetry disables dependency URL collection", async () => {
  const host = JSON.parse(await readFile(new URL("../host.json", import.meta.url), "utf8"));
  assert.equal(host.logging.applicationInsights.enableDependencyTracking, false);
});

test("immediate failure alert excludes transient Graph failures and duplicate wrappers", async () => {
  const source = await readFile(new URL("../infra/main.bicep", import.meta.url), "utf8");
  assert.match(source, /event == "canary-run-failed" and errorCode != "graph-request-failed"/);
  assert.match(source, /event == "canary-invocation-failed" and phase != "canary-run"/);
  assert.doesNotMatch(
    source,
    /event\) in \("canary-run-failed", "canary-invocation-failed"\)/,
  );
});
