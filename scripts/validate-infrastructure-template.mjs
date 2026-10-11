import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const templatePath = process.argv[2];
if (!templatePath) throw new Error("A compiled ARM template path is required");

const template = JSON.parse(await readFile(templatePath, "utf8"));
const functionApp = template.resources?.find(
  (resource) => resource.type === "Microsoft.Web/sites" && resource.kind === "functionapp,linux",
);
assert.ok(functionApp, "Compiled template must contain the Linux Function App");
assert.ok(Array.isArray(functionApp.dependsOn), "Function App must declare dependencies");

assert.equal(
  functionApp.dependsOn.some(
    (dependency) =>
      dependency.includes("Microsoft.Storage/storageAccounts/blobServices/containers") &&
      dependency.includes("deploymentContainerName"),
  ),
  true,
  "Function App must depend on the deployment container",
);
assert.equal(
  functionApp.dependsOn.some(
    (dependency) =>
      dependency.includes("Microsoft.Authorization/roleAssignments") &&
      dependency.includes("storageBlobDataOwnerRoleId"),
  ),
  true,
  "Function App must depend on its Blob Data Owner assignment",
);

const serialized = JSON.stringify(template);
for (const forbiddenRoleId of [
  "974c5e8b-45b9-4653-ba55-5f855dd0fb88",
  "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3",
]) {
  assert.equal(
    serialized.includes(forbiddenRoleId),
    false,
    "Read-only canary must not grant Queue or Table Data Contributor",
  );
}

console.log("Compiled infrastructure dependency validation passed.");
