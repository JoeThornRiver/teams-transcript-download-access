import assert from "node:assert/strict";
import test from "node:test";

import { grantRecordingReadAccess } from "../src/recording-access.mjs";

test("grants only missing read access and a second run is idempotent", async () => {
  const fixture = createGraphFixture();
  await grantRecordingReadAccess(baseOptions(fixture));

  assert.deepEqual(fixture.invites, [
    {
      recipients: [{ email: "external@example.test" }],
      requireSignIn: true,
      retainInheritedPermissions: true,
      roles: ["read"],
      sendInvitation: false,
    },
  ]);

  await grantRecordingReadAccess(baseOptions(fixture));
  assert.equal(fixture.invites.length, 1);
});

test("fails loudly when generated link state changes", async () => {
  const fixture = createGraphFixture({ mutateLinkAfterInvite: true });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /Generated sharing-link state changed/,
  );
});

test("fails when the resulting new permission is stronger than read", async () => {
  const fixture = createGraphFixture({ grantedRole: "write" });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /newly granted recipient permission was not read-only/,
  );
});

test("rejects a new permission containing an additional role", async () => {
  const fixture = createGraphFixture({ newPermissionRoles: ["read", "sharingManagement"] });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /newly granted recipient permission was not read-only/,
  );
});

test("rejects a combined permission covering multiple recipients", async () => {
  const fixture = createGraphFixture({ combineNewPermission: true });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /newly granted recipient permission was not read-only/,
  );
});

test("rejects a returned read permission containing an unrelated group", async () => {
  const fixture = createGraphFixture({ addOpaqueGroup: true });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /newly granted recipient permission was not read-only/,
  );
});

test("accepts an additional email alias on the matching returned identity", async () => {
  const fixture = createGraphFixture({ returnedEmailAlias: true, sourceIdOnly: true });
  await grantRecordingReadAccess(baseOptions(fixture));
  assert.equal(fixture.invites.length, 1);
});

test("accepts non-overlapping compatibility identities for the same recipient", async () => {
  const fixture = createGraphFixture({ splitCompatibilityIdentity: true });
  await grantRecordingReadAccess(baseOptions(fixture));
  assert.equal(fixture.invites.length, 1);
});

test("fails when a pre-existing direct permission changes", async () => {
  const fixture = createGraphFixture({ mutateOwnerAfterInvite: true });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /pre-existing direct permission changed/,
  );
});

test("fails when a non-role field on a pre-existing direct permission changes", async () => {
  const fixture = createGraphFixture({ mutateExpirationAfterInvite: true });
  await assert.rejects(
    () => grantRecordingReadAccess(baseOptions(fixture)),
    /pre-existing direct permission changed/,
  );
});

test("Graph failures never include untrusted response header content", async () => {
  const sensitive = "participant@example.test-private-recording";
  await assert.rejects(
    () =>
      grantRecordingReadAccess({
        ...baseOptions({
          baseUrl: "https://graph.test/v1.0",
          fetchImpl: async () =>
            new Response("failure", {
              headers: { "request-id": sensitive },
              status: 500,
            }),
        }),
      }),
    (error) => {
      assert.equal(error.message, "Microsoft Graph request failed with HTTP 500");
      assert.equal(error.message.includes(sensitive), false);
      return true;
    },
  );
});

test("Graph failures expose only sanitized response diagnostics", async () => {
  await assert.rejects(
    () =>
      grantRecordingReadAccess({
        ...baseOptions({
          baseUrl: "https://graph.test/v1.0",
          fetchImpl: async () =>
            json(503, {
              error: {
                code: "serviceNotAvailable",
                message:
                  "Failed for participant@example.test at https://tenant.example/recording " +
                  "with id 01234567-89ab-cdef-0123-456789abcdef",
              },
            }),
        }),
      }),
    (error) => {
      assert.equal(error.graphHttpStatus, 503);
      assert.equal(error.graphErrorCode, "serviceNotAvailable");
      assert.equal(
        error.graphErrorMessage,
        "Failed for [redacted] at [redacted] with id [redacted]",
      );
      return true;
    },
  );
});

function baseOptions(fixture) {
  return {
    accessToken: "test-token-must-never-be-returned",
    driveId: "organizer-drive",
    fetchImpl: fixture.fetchImpl,
    graphBaseUrl: fixture.baseUrl,
    itemId: "recording-item",
  };
}

function createGraphFixture({
  addOpaqueGroup = false,
  combineNewPermission = false,
  grantedRole = "read",
  mutateExpirationAfterInvite = false,
  mutateLinkAfterInvite = false,
  mutateOwnerAfterInvite = false,
  newPermissionRoles,
  returnedEmailAlias = false,
  sourceIdOnly = false,
  splitCompatibilityIdentity = false,
} = {}) {
  const invites = [];
  const directRecipients = [
    { identity: { user: { id: "member" } }, role: "read" },
    { identity: { user: { id: "guest" } }, role: "write" },
  ];
  let linkMutated = false;
  let expirationMutated = false;
  let ownerMutated = false;
  const additionalPermissions = [];

  const fetchImpl = async (requestUrl, options) => {
    assert.equal(options.headers.authorization, "Bearer test-token-must-never-be-returned");
    const url = new URL(requestUrl);

    if (
      options.method === "GET" &&
      url.pathname === "/v1.0/drives/organizer-drive/items/recording-item/permissions"
    ) {
      return json(200, {
        value: [
          {
            grantedToV2: { user: { id: "organizer" } },
            id: "owner-permission",
            expirationDateTime: expirationMutated ? "2031-01-01T00:00:00Z" : null,
            roles: [ownerMutated ? "write" : "owner"],
          },
          ...directRecipients.map(({ identity, role }, index) => ({
            grantedToV2: identity,
            id: `direct-${index}`,
            roles: [role],
          })),
          ...additionalPermissions,
          {
            grantedToIdentitiesV2: [
              { user: { email: "member@example.test", id: "member" } },
              { user: { email: "guest@example.test", id: "guest" } },
              {
                user: {
                  ...(sourceIdOnly ? { id: "external-id" } : { email: "external@example.test" }),
                  ...(splitCompatibilityIdentity ? { id: "external-id" } : {}),
                },
              },
            ],
            id: "generated-link",
            link: {
              preventsDownload: true,
              scope: "users",
              type: "view",
              webUrl: linkMutated
                ? "https://tenant.example/changed-link"
                : "https://tenant.example/original-link",
            },
            roles: ["read"],
          },
        ],
      });
    }

    if (
      options.method === "POST" &&
      url.pathname === "/v1.0/drives/organizer-drive/items/recording-item/invite"
    ) {
      const body = JSON.parse(options.body);
      invites.push(body);
      for (const recipient of body.recipients) {
        const identity = recipient.objectId
          ? {
              user: {
                id: recipient.objectId,
                ...(returnedEmailAlias ? { email: "alias@example.test" } : {}),
              },
            }
          : { user: { email: recipient.email } };
        if (splitCompatibilityIdentity) {
          additionalPermissions.push({
            grantedTo: { user: { email: "external@example.test" } },
            grantedToV2: identity,
            id: "split-compatibility-permission",
            roles: ["read"],
          });
        } else if (addOpaqueGroup || combineNewPermission || newPermissionRoles) {
          additionalPermissions.push({
            grantedToIdentitiesV2: [
              identity,
              ...(combineNewPermission ? [{ user: { id: "unrelated-recipient" } }] : []),
              ...(addOpaqueGroup ? [{ group: { id: "unrelated-group" } }] : []),
            ],
            id: "unsafe-new-permission",
            roles: newPermissionRoles ?? ["read"],
          });
        } else {
          directRecipients.push({ identity, role: grantedRole });
        }
      }
      linkMutated = mutateLinkAfterInvite;
      expirationMutated = mutateExpirationAfterInvite;
      ownerMutated = mutateOwnerAfterInvite;
      return json(200, { value: [] });
    }

    assert.fail(`Unexpected Graph request: ${options.method} ${url.pathname}`);
  };

  return {
    baseUrl: "https://graph.test/v1.0",
    fetchImpl,
    invites,
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
