import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApplicationToken,
  buildSearchRequest,
  discoverRecordings,
  isOrganizerRecordingLocation,
} from "../src/recording-discovery.mjs";

test("tenant search rejects page sizes outside the supported range", async () => {
  const options = {
    accessToken: token({ roles: ["Files.ReadWrite.All"] }),
    createdAfter: "2026-10-06T12:00:00.000Z",
    fetchImpl: async () => assert.fail("Graph must not be called"),
    pageSize: 1001,
    region: "EUR",
  };
  await assert.rejects(() => discoverRecordings(options), /between 1 and 1000/);
});

test("buildSearchRequest scopes results by file type and creation time", () => {
  assert.deepEqual(
    buildSearchRequest({
      createdAfter: "2026-10-06T12:00:00.000Z",
      from: 200,
      region: "EUR",
      size: 100,
    }),
    {
      requests: [
        {
          entityTypes: ["driveItem"],
          fields: ["id", "parentReference"],
          from: 200,
          query: {
            queryString:
              "filetype:mp4 AND Created>2026-10-06T12:00:00.000Z",
          },
          region: "EUR",
          sharePointOneDriveOptions: {
            includeContent: "privateContent,sharedContent",
          },
          size: 100,
        },
      ],
    },
  );
});

test("organizer recordings require a business drive and the recordings special folder", () => {
  assert.equal(
    isOrganizerRecordingLocation({
      drive: { driveType: "business" },
      parent: { specialFolder: { name: "recordings" } },
    }),
    true,
  );
  assert.equal(
    isOrganizerRecordingLocation({
      drive: { driveType: "documentLibrary" },
      parent: { specialFolder: { name: "recordings" } },
    }),
    false,
  );
  assert.equal(
    isOrganizerRecordingLocation({
      drive: { driveType: "business" },
      parent: { name: "Aufnahmen" },
    }),
    false,
  );
});

test("application-token validation rejects delegated and underprivileged tokens", () => {
  const applicationToken = token({ roles: ["Files.ReadWrite.All"] });
  assert.doesNotThrow(() => assertApplicationToken(applicationToken));

  assert.throws(
    () => assertApplicationToken(token({ scp: "Files.ReadWrite" })),
    /application token/,
  );
  assert.throws(
    () => assertApplicationToken(token({ roles: ["Files.Read.All"] })),
    /Files.ReadWrite.All/,
  );
  assert.throws(
    () =>
      assertApplicationToken(
        token({ roles: ["Files.ReadWrite.All", "User.Read.All"] }),
      ),
    /only the Files.ReadWrite.All application role/,
  );
  assert.throws(() => assertApplicationToken("not-a-jwt"), /valid JWT/);
});

function token(payload) {
  return [
    encode({ alg: "none" }),
    encode(payload),
    "signature",
  ].join(".");
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
