import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const installUrl = new URL("../scripts/install-tenant.sh", import.meta.url);
const uninstallUrl = new URL("../scripts/uninstall-tenant.sh", import.meta.url);
test("tenant lifecycle exposes only the supported install and uninstall inputs", async () => {
  const [install, uninstall, common] = await Promise.all([
    readFile(installUrl, "utf8"), readFile(uninstallUrl, "utf8"),
    readFile(new URL("../scripts/tenant-lifecycle-common.sh", import.meta.url), "utf8"),
  ]);
  const lifecycle = `${common}\n${install}`;
  for (const prompt of ["Deployment name", "Azure subscription", "Azure region", "Microsoft Search region", "Alert email address"])
    assert.match(lifecycle, new RegExp(prompt));
  for (const fixed of ["0 */5 * * * *", "14", "30", "100"])
    assert.equal(install.includes(fixed), true, `missing fixed operational value: ${fixed}`);
  assert.match(lifecycle, /Files\.ReadWrite\.All/);
  assert.doesNotMatch(lifecycle, /User\.Read\.All/);
  assert.match(`${common}\n${uninstall}`, /Files\.ReadWrite\.All/);
  assert.match(uninstall, /does not remove direct recording permissions/);
  assert.doesNotMatch(install, /properties\.(emailReceivers|enabled)/);
});
test("mocked control plane supports install, upgrade, safe removal, and retry", async () => {
  const fixture = await createFixture();
  const installInput = "demo\n1\nwesteurope\nEMEA\nalerts@example.invalid\ny\n\n";
  const install = run(fixture, "install-tenant.sh", installInput);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Technical deployment is verified/);
  assert.match(install.stdout, /Azure sent a verification message/);
  let log = await readFile(join(fixture, "az.log"), "utf8");
  const deployment = log.split("\n").find((line) => line.startsWith("deployment sub create"));
  assert.equal(deployment, `deployment sub create --name tra-demo --location westeurope --template-file ${join(fixture, "infra", "tenant.bicep")} --parameters deploymentName=demo location=westeurope microsoftSearchRegion=EMEA alertEmailAddress=alerts@example.invalid --output none`);
  assert.equal((await readFile(join(fixture, "build.log"), "utf8")).trim(), git(fixture, "rev-parse", "HEAD"));
  const upgrade = run(fixture, "install-tenant.sh", "demo\n1\ny\n\n");
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.doesNotMatch(upgrade.stdout, /Azure sent a verification message/);
  log = await readFile(join(fixture, "az.log"), "utf8");
  assert.equal(count(log, "rest --method post --url https://graph.microsoft.com/v1.0/servicePrincipals/"), 1, "upgrade duplicated the Graph role");
  assert.equal(count(log, "deployment sub create"), 2, "upgrade did not converge through the same deployment");
  assert.equal(count(log, "login --allow-no-subscriptions"), 2);
  assert.equal(count(log, "login --output none"), 2);
  assert.equal(count(log, "/v1/workspaces/"), 0, "installer queried runtime telemetry");
  const blocked = run(fixture, "uninstall-tenant.sh", "demo\n1\ny\n", { FAIL_REVOKE: "1" });
  assert.notEqual(blocked.status, 0);
  log = await readFile(join(fixture, "az.log"), "utf8");
  assert.equal(count(log, "group delete"), 0, "resource group was deleted after failed role revocation");
  const removed = run(fixture, "uninstall-tenant.sh", "demo\n1\ny\n");
  assert.equal(removed.status, 0, removed.stderr);
  const repeated = run(fixture, "uninstall-tenant.sh", "demo\n1\n");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already absent/);
  log = await readFile(join(fixture, "az.log"), "utf8");
  assert.ok(log.indexOf("rest --method delete") < log.indexOf("group delete"));
  for (const privateValue of ["mi-secret", "graph-secret", "role-secret", "alerts@example.invalid"])
    assert.equal(`${install.stdout}${install.stderr}${removed.stdout}${removed.stderr}`.includes(privateValue), false);
});
test("correctable install inputs are explained and requested again before preview", async () => {
  const fixture = await createFixture();
  const input = "Invalid_Name\ndemo\n18446744073709551617\n0\n2\nmoon\nwesteurope\nde\nemea\nEUROPE\nEMEA\ninvalid\nalerts@example.invalid\nn\n";
  const result = run(fixture, "install-tenant.sh", input);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\) Test Subscription/);
  assert.match(result.stdout, /2\) Other Subscription/);
  assert.match(result.stderr, /Deployment name must be 3-12 lowercase/);
  assert.equal(count(result.stderr, "Choose a subscription number from the displayed list."), 2);
  assert.match(result.stderr, /Azure region must be one of the locations available/);
  assert.equal(count(result.stderr, "Microsoft Search region must contain three or four uppercase letters."), 3);
  assert.match(result.stderr, /Alert email address is invalid/);
  const log = await readFile(join(fixture, "az.log"), "utf8");
  assert.match(log, /account set --subscription Other Subscription/);
  assert.equal(count(log, "deployment sub what-if"), 1);
  assert.equal(count(log, "deployment sub create"), 0);

  const incomplete = await createFixture();
  const stopped = run(incomplete, "install-tenant.sh", "demo\n1\nmoon\n");
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /Input ended before all required values/);
  assert.doesNotMatch(await readFile(join(incomplete, "az.log"), "utf8"), /deployment sub (what-if|create)/);
});
test("installation summarizes what-if safely and waits for the Flex Function state", async () => {
  const fixture = await createFixture();
  const input = "demo\n1\nwesteurope\nDEU\nalerts@example.invalid\ny\n\n";
  const result = run(fixture, "install-tenant.sh", input, { FUNCTION_START_DELAY: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview change types: Create: 2, Modify: 1/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /preview-secret/);
  const log = await readFile(join(fixture, "az.log"), "utf8");
  assert.match(log, /deployment sub what-if .*--result-format ResourceIdOnly --no-pretty-print/);
  assert.match(log, /resource show .*--resource-type Microsoft\.Web\/sites --query properties\.state/);
  assert.doesNotMatch(log, /functionapp show/);

  const stopped = await createFixture();
  const failed = run(stopped, "install-tenant.sh", input, { FAKE_FUNCTION_STATE: "Stopped" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Function App is not running/);
  assert.equal(count(await readFile(join(stopped, "az.log"), "utf8"), "resource show"), 12);
});
test("preflight, ownership, permission, receiver, and privacy failures stop safely", async () => {
  const missing = spawnSync("/bin/bash", ["-c", `source '${new URL("../scripts/tenant-lifecycle-common.sh", import.meta.url).pathname}'; command(){ [[ "$1" == -v && "$2" == zip ]] && return 1; builtin command "$@"; }; require_environment`], { encoding: "utf8" });
  assert.match(missing.stderr, /Missing required command: zip/);
  for (const [env, expected] of [
    [{ FAKE_OS: "Windows" }, /Only macOS and Linux/],
    [{ AZ_VERSION: "2.0.0" }, /Azure CLI 2.60 or newer/],
  ]) {
    const fixture = await createFixture();
    assert.match(run(fixture, "install-tenant.sh", "", env).stderr, expected);
  }
  const noSubscriptions = await createFixture();
  assert.match(run(noSubscriptions, "install-tenant.sh", "demo\n", { NO_SUBSCRIPTIONS: "1" }).stderr, /No enabled Azure subscription/);
  const dirty = await createFixture();
  await writeFile(join(dirty, "untracked.tmp"), "dirty");
  assert.match(run(dirty, "install-tenant.sh", "").stderr, /untracked files/);
  await unlink(join(dirty, "untracked.tmp"));
  const abort = await createFixture();
  assert.equal(run(abort, "install-tenant.sh", "demo\n1\nwesteurope\nDEU\nalerts@example.invalid\nn\n").status, 0);
  assert.equal(count(await readFile(join(abort, "az.log"), "utf8"), "deployment sub create"), 0);
  const collision = await createFixture();
  await writeFile(join(collision, "state-rg"), "");
  assert.match(run(collision, "install-tenant.sh", "demo\n1\n", { GROUP_OWNER: "other" }).stderr, /not owned/);
  const unrelated = await createFixture();
  await writeFile(join(unrelated, "state-rg"), "");
  assert.match(run(unrelated, "uninstall-tenant.sh", "demo\n1\ny\n", { EXTRA_RESOURCE: "1" }).stderr, /not owned/);
  assert.equal(count(await readFile(join(unrelated, "az.log"), "utf8"), "group delete"), 0);

  const uninstallAbort = await createFixture();
  await writeFile(join(uninstallAbort, "state-rg"), "");
  assert.equal(run(uninstallAbort, "uninstall-tenant.sh", "demo\n1\nn\n").status, 0);
  assert.doesNotMatch(await readFile(join(uninstallAbort, "az.log"), "utf8"), /(functionapp stop|rest --method delete|group delete)/);

  for (const [env, expected] of [
    [{ ROLE_COUNT: "2" }, /incompatible Microsoft Graph/],
    [{ RECEIVER_STATUS: "Disabled" }, /receiver is not Enabled/],
    [{ FAIL_COMMAND: "deployment sub create" }, /Azure deployment failed/],
  ]) {
    const fixture = await createFixture();
    const result = run(fixture, "install-tenant.sh", "demo\n1\nwesteurope\nDEU\nalerts@example.invalid\ny\n\n", env);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-identifier/);
  }

  const partial = await createFixture();
  await writeFile(join(partial, "state-rg"), "");
  assert.equal(run(partial, "install-tenant.sh", "demo\n1\ny\n\n").status, 0);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tenant-lifecycle-"));
  await Promise.all(["scripts", "infra", "bin"].map((name) => mkdir(join(root, name))));
  await Promise.all(["install-tenant.sh", "uninstall-tenant.sh", "tenant-lifecycle-common.sh"].map((name) =>
    copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name))));
  await writeExecutable(join(root, "scripts", "build-function-release.sh"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$1\" > build.log\n: > \"$2\"\n");
  await writeFile(join(root, "infra", "tenant.bicep"), "// mocked template\n");
  await writeFile(join(root, ".gitignore"), "az.log\nbuild.log\nstate-*\n");
  await writeExecutable(join(root, "bin", "az"), azMock);
  await writeExecutable(join(root, "bin", "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(root, "bin", "uname"), "#!/usr/bin/env bash\necho \"\${FAKE_OS:-Linux}\"\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

function run(root, script, input, extraEnv = {}) {
  return spawnSync("/bin/bash", [join(root, "scripts", script)], { cwd: root, encoding: "utf8", input,
    env: { ...process.env, ...extraEnv, AZ_LOG: join(root, "az.log"), AZ_STATE: join(root, "state"), PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writeExecutable(path, content) { await writeFile(path, content); await chmod(path, 0o755); }
function count(value, needle) { return value.split(needle).length - 1; }

const azMock = `#!/usr/bin/env bash
echo "$*" >> "$AZ_LOG"
args="$*"
has() { [[ "$args" == *"$1"* ]]; }
if [[ -n "\${FAIL_COMMAND:-}" && "$args" == *"$FAIL_COMMAND"* ]]; then echo 'private-identifier raw service error' >&2; exit 1; fi
if has 'version --query'; then echo "\${AZ_VERSION:-2.89.1}"
elif has 'bicep version'; then echo 0.48.1
elif has 'cloud show'; then echo AzureCloud
elif has 'account list-locations'; then printf 'westeurope\neastus\n'
elif has 'account list'; then [[ -n "\${NO_SUBSCRIPTIONS:-}" ]] || printf 'Test Subscription\nOther Subscription\n'
elif has 'account show' && has '--query name'; then echo 'Test Subscription'
elif has 'group exists'; then [[ -f "$AZ_STATE-rg" ]] && echo true || echo false
elif has 'group show' && has 'tags.recordingAccessDeployment'; then echo "\${GROUP_OWNER:-demo}"
elif has 'group show' && has 'location'; then echo westeurope
elif has 'properties.parameters.deploymentName'; then echo demo
elif has 'properties.parameters.microsoftSearchRegion'; then echo DEU
elif has 'properties.outputs.functionAppName'; then echo tra-demo-function
elif has 'properties.outputs.actionGroupName'; then echo tra-demo-alerts
elif has 'properties.outputs.managedIdentityPrincipalId'; then echo mi-secret
elif has 'properties.outputs.storageAccountResourceId'; then echo storage-secret
elif has 'deployment sub what-if'; then
  if has '--result-format ResourceIdOnly' && has '--no-pretty-print'; then printf 'Create\nCreate\nModify\n'; else echo 'preview-secret raw resource payload'; fi
elif has 'deployment sub create'; then touch "$AZ_STATE-rg"
elif has 'action-group list'; then echo alerts@example.invalid
elif has 'resource list'; then printf 'Microsoft.Web/sites\ttra-demo-function\nMicrosoft.ManagedIdentity/userAssignedIdentities\ttra-demo-identity\nmicrosoft.insights/actiongroups\tApplication Insights Smart Detection\n'; [[ -z "\${EXTRA_RESOURCE:-}" ]] || printf 'microsoft.insights/actiongroups\tapplication insights smart detection\n'
elif has 'deployment group show' && has 'functionAppName'; then echo tra-demo-function
elif has 'deployment group show' && has 'storageAccountName'; then echo tra-demo-storage
elif has 'resource show' && has 'properties.state'; then
  attempts_file="$AZ_STATE-function-attempts"
  attempts=0; [[ ! -f "$attempts_file" ]] || attempts="$(<"$attempts_file")"
  attempts=$((attempts + 1)); echo "$attempts" > "$attempts_file"
  [[ "\${FAKE_FUNCTION_STATE:-Running}" != 'Stopped' && "$attempts" -gt "\${FUNCTION_START_DELAY:-0}" ]] && echo Running || echo "\${FAKE_FUNCTION_STATE:-Starting}"
elif has 'resource show'; then echo tra-demo-function
elif has 'identity show'; then echo mi-secret
elif has 'ad sp show' && has '--query id'; then echo graph-secret
elif has 'ad sp show'; then echo role-secret
elif has 'rest --method post'; then touch "$AZ_STATE-role"
elif has 'rest --method delete'; then [[ -z "\${FAIL_REVOKE:-}" ]] || exit 1; rm -f "$AZ_STATE-role"
elif has 'rest --method get' && has 'length('; then [[ -n "\${ROLE_COUNT:-}" ]] && echo "$ROLE_COUNT" || { [[ -f "$AZ_STATE-role" ]] && echo 1 || echo 0; }
elif has 'rest --method get' && has 'appRoleId'; then echo role-secret
elif has 'rest --method get'; then echo assignment-secret
elif has 'emailAddress'; then echo alerts@example.invalid
elif has 'emailReceivers' && has 'status'; then
  if [[ -n "\${RECEIVER_STATUS:-}" ]]; then echo "$RECEIVER_STATUS"
  else
    attempts_file="$AZ_STATE-receiver-attempts"
    attempts=0; [[ ! -f "$attempts_file" ]] || attempts="$(<"$attempts_file")"
    attempts=$((attempts + 1)); echo "$attempts" > "$attempts_file"
    [[ "$attempts" == 1 ]] && echo Pending || echo Enabled
  fi
elif has 'action-group show'; then echo true
elif has 'functionapp config appsettings list'; then
  has 'CANARY_TIMER_SCHEDULE' && echo '0 */5 * * * *' || { has 'MAX_LOOKBACK_DAYS' && echo 14 || { has 'SEARCH_INDEX_OVERLAP_MINUTES' && echo 30 || echo 100; }; }
elif has 'functionapp show'; then echo Running
elif has 'functionapp function list'; then echo 1
elif has 'functionapp list' && has 'length('; then echo 1
elif has 'functionapp list'; then echo tra-demo-function
elif has 'identity list' && has 'length('; then echo 1
elif has 'identity list'; then echo mi-secret
elif has 'scheduled-query show'; then echo true
elif has 'role assignment list'; then echo 1
elif has 'group delete'; then rm -f "$AZ_STATE-rg"
fi
exit 0
`;
