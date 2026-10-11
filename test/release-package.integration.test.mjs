import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packagerSource = new URL("../scripts/build-function-release.sh", import.meta.url);

test("release package uses only the selected Git revision", async (t) => {
  const fixture = await createFixture(t);
  const revision = await git(fixture, "rev-parse", "HEAD");
  const output = join(fixture, "release.zip");

  await writeFile(
    join(fixture, "src/functions/recording-discovery-canary.mjs"),
    'export const source = "modified working tree";\n',
  );
  await writeFile(
    join(fixture, "src/functions/recording-discovery-canary 2.mjs"),
    'export const source = "untracked duplicate";\n',
  );

  await runPackager(fixture, revision, output);

  const entries = (await unzip(output, "-Z1")).trim().split("\n");
  assert.equal(entries.includes("src/functions/recording-discovery-canary 2.mjs"), false);
  assert.equal(entries.some((entry) => entry.startsWith("docs/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("test/")), false);
  assert.equal(
    await unzipMember(output, "src/functions/recording-discovery-canary.mjs"),
    'export const source = "reviewed commit";\n',
  );
});

test("release package rejects missing and multiple Function entry points", async (t) => {
  for (const functionCount of [0, 2]) {
    const fixture = await createFixture(t, { functionCount });
    const output = join(fixture, "release.zip");

    await assert.rejects(
      runPackager(fixture, "HEAD", output),
      /exactly one Function entry point/,
    );
    await assertMissing(output);
  }
});

test("dependency installation failure prevents package output", async (t) => {
  const fixture = await createFixture(t);
  const shimDirectory = join(fixture, "command-shims");
  const npmShim = join(shimDirectory, "npm");
  await mkdir(shimDirectory);
  await writeFile(npmShim, "#!/bin/sh\nexit 42\n");
  await chmod(npmShim, 0o755);

  const output = join(fixture, "release.zip");
  await assert.rejects(
    runPackager(fixture, "HEAD", output, {
      PATH: `${shimDirectory}:${process.env.PATH}`,
    }),
  );
  await assertMissing(output);
});

test("corrupt ZIP output fails integrity validation", async (t) => {
  const fixture = await createFixture(t);
  const shimDirectory = join(fixture, "command-shims");
  const zipShim = join(shimDirectory, "zip");
  await mkdir(shimDirectory);
  await writeFile(zipShim, "#!/bin/sh\nshift\nprintf 'not-a-zip' > \"$1\"\n");
  await chmod(zipShim, 0o755);

  const output = join(fixture, "release.zip");
  await assert.rejects(
    runPackager(fixture, "HEAD", output, {
      PATH: `${shimDirectory}:${process.env.PATH}`,
    }),
  );
  await assertMissing(output);
});

test("revision symlinks cannot import local content", async (t) => {
  const fixture = await createFixture(t);
  const externalFile = join(dirname(fixture), `${fixture.split("/").at(-1)}-external.txt`);
  t.after(() => rm(externalFile, { force: true }));
  await writeFile(externalFile, "workstation-only content\n");
  await symlink(externalFile, join(fixture, "src/local-content.txt"));
  await git(fixture, "add", "src/local-content.txt");
  await git(fixture, "commit", "--quiet", "-m", "add symlink");

  const output = join(fixture, "release.zip");
  await assert.rejects(runPackager(fixture, "HEAD", output), /symbolic links/);
  await assertMissing(output);
});

test("symlinks outside runtime inputs do not block packaging", async (t) => {
  const fixture = await createFixture(t);
  await symlink("not-runtime.md", join(fixture, "docs/current-guide.md"));
  await git(fixture, "add", "docs/current-guide.md");
  await git(fixture, "commit", "--quiet", "-m", "add excluded documentation symlink");

  const output = join(fixture, "release.zip");
  await runPackager(fixture, "HEAD", output);

  const entries = (await unzip(output, "-Z1")).trim().split("\n");
  assert.equal(entries.some((entry) => entry.startsWith("docs/")), false);
});

test("publication failure leaves no requested release file", async (t) => {
  const fixture = await createFixture(t);
  const shimDirectory = join(fixture, "command-shims");
  const copyShim = join(shimDirectory, "cp");
  await mkdir(shimDirectory);
  await writeFile(copyShim, "#!/bin/sh\nprintf 'part' > \"$2\"\nexit 42\n");
  await chmod(copyShim, 0o755);

  const output = join(fixture, "release.zip");
  await assert.rejects(
    runPackager(fixture, "HEAD", output, {
      PATH: `${shimDirectory}:${process.env.PATH}`,
    }),
  );
  await assertMissing(output);
});

test("deployment runbook builds the release from an explicit Git revision", async () => {
  const runbook = await readFile(
    new URL("../docs/azure-canary-deployment.md", import.meta.url),
    "utf8",
  );

  assert.equal(
    runbook.includes('./scripts/build-function-release.sh \\\n  "$RELEASE_REVISION"'),
    true,
  );
  assert.doesNotMatch(runbook, /cp -R src/);
});

async function createFixture(t, { functionCount = 1 } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "release-package-test-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));

  await mkdir(join(fixture, "scripts"), { recursive: true });
  await mkdir(join(fixture, "src/functions"), { recursive: true });
  await mkdir(join(fixture, "docs"), { recursive: true });
  await mkdir(join(fixture, "test"), { recursive: true });
  await copyFile(packagerSource, join(fixture, "scripts/build-function-release.sh"));
  await chmod(join(fixture, "scripts/build-function-release.sh"), 0o755);
  await writeFile(join(fixture, "host.json"), '{"version":"2.0"}\n');
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ main: "src/functions/*.mjs", name: "fixture", private: true }, null, 2),
  );
  await writeFile(
    join(fixture, "package-lock.json"),
    JSON.stringify(
      {
        lockfileVersion: 3,
        name: "fixture",
        packages: { "": { name: "fixture" } },
        requires: true,
      },
      null,
      2,
    ),
  );
  await writeFile(join(fixture, "docs/not-runtime.md"), "not runtime\n");
  await writeFile(join(fixture, "test/not-runtime.test.mjs"), "not runtime\n");

  for (let index = 0; index < functionCount; index += 1) {
    const name = index === 0 ? "recording-discovery-canary.mjs" : `extra-${index}.mjs`;
    await writeFile(
      join(fixture, "src/functions", name),
      'export const source = "reviewed commit";\n',
    );
  }

  await git(fixture, "init", "--quiet");
  await git(fixture, "config", "user.email", "release-test@example.invalid");
  await git(fixture, "config", "user.name", "Release Test");
  await git(fixture, "add", ".");
  await git(fixture, "commit", "--quiet", "-m", "fixture");
  return fixture;
}

async function runPackager(repository, revision, output, environment = process.env) {
  return execFileAsync(
    join(repository, "scripts/build-function-release.sh"),
    [revision, output],
    { cwd: repository, env: environment },
  );
}

async function git(repository, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, { cwd: repository });
  return stdout.trim();
}

async function unzip(archive, ...arguments_) {
  const { stdout } = await execFileAsync("unzip", [...arguments_, archive]);
  return stdout;
}

async function unzipMember(archive, member) {
  const { stdout } = await execFileAsync("unzip", ["-p", archive, member]);
  return stdout;
}

async function assertMissing(path) {
  await assert.rejects(access(path));
}
