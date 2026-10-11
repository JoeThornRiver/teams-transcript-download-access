import assert from "node:assert/strict";
import test from "node:test";

import {
  directAccessKeys,
  linkSnapshot,
  selectBlockedDownloadRecipients,
} from "../src/recording-access.mjs";

test("selectBlockedDownloadRecipients treats every resolvable recipient identically", () => {
  const recipients = selectBlockedDownloadRecipients([
    linkPermission({
      recipients: [
        { user: { email: "member@example.test", id: "member" } },
        { user: { email: "GUEST@example.test", id: "guest" } },
        { user: { email: "external@example.test" } },
        { user: { email: "guest@example.test", id: "guest" } },
        { user: {} },
      ],
      scope: "users",
      type: "blocksDownload",
    }),
    linkPermission({
      recipients: [{ user: { id: "ordinary-view" } }],
      scope: "users",
      type: "view",
    }),
    linkPermission({
      preventsDownload: false,
      recipients: [{ user: { id: "download-allowed-view" } }],
      scope: "users",
      type: "view",
    }),
    linkPermission({
      preventsDownload: "true",
      recipients: [{ user: { id: "string-protection-view" } }],
      scope: "users",
      type: "view",
    }),
    linkPermission({
      preventsDownload: 1,
      recipients: [{ user: { id: "numeric-protection-view" } }],
      scope: "users",
      type: "view",
    }),
    linkPermission({
      preventsDownload: true,
      recipients: [{ user: { id: "wrong-scope-protected-view" } }],
      scope: "organization",
      type: "view",
    }),
    linkPermission({
      preventsDownload: true,
      recipients: [{ user: { id: "protected-view-recipient" } }],
      scope: "users",
      type: "view",
    }),
  ]);

  assert.deepEqual(
    recipients.map(({ invite }) => invite),
    [
      { objectId: "member" },
      { objectId: "guest" },
      { email: "external@example.test" },
      { objectId: "protected-view-recipient" },
    ],
  );
});

test("directAccessKeys matches IDs and email fallback but ignores links and inherited access", () => {
  const permissions = [
    permission("read-a", ["read"], { user: { id: "user-a" } }),
    permission("write-b", ["write"], { user: { email: "B@example.test" } }),
    {
      grantedToV2: { siteUser: { loginName: "i:0#.f|membership|c@example.test" } },
      id: "read-c",
      roles: ["read"],
    },
    {
      grantedToV2: { user: { id: "resolved-external" } },
      id: "read-d",
      invitation: { email: "d@example.test" },
      roles: ["read"],
    },
    {
      ...permission("inherited", ["write"], { user: { id: "user-c" } }),
      inheritedFrom: { id: "parent" },
    },
    {
      ...permission("link", ["read"], { user: { id: "user-d" } }),
      link: { type: "view", webUrl: "https://secret" },
    },
  ];

  assert.deepEqual([...directAccessKeys(permissions)], [
    "id:user-a",
    "email:b@example.test",
    "email:c@example.test",
    "email:d@example.test",
    "id:resolved-external",
  ]);
});

test("linkSnapshot is order-independent and protects all link fields and recipient identities", () => {
  const first = linkPermission({
    id: "link-1",
    recipients: [{ user: { id: "user-b" } }, { user: { email: "a@example.test" } }],
    scope: "users",
    type: "blocksDownload",
    webUrl: "https://secret/link-one",
  });
  const second = linkPermission({
    id: "link-2",
    recipients: [],
    scope: "organization",
    type: "view",
    webUrl: "https://secret/link-two",
  });

  const baseline = linkSnapshot([first, second]);
  assert.equal(linkSnapshot([second, first]), baseline);

  for (const changed of [
    { ...first, id: "changed" },
    { ...first, link: { ...first.link, webUrl: "https://secret/changed" } },
    { ...first, link: { ...first.link, type: "view" } },
    { ...first, link: { ...first.link, scope: "organization" } },
    { ...first, link: { ...first.link, preventsDownload: true } },
    { ...first, roles: ["write"] },
    { ...first, grantedToIdentitiesV2: [{ user: { id: "user-c" } }] },
    { ...first, grantedToIdentitiesV2: [{ group: { id: "group-c" } }] },
  ]) {
    assert.notEqual(linkSnapshot([changed, second]), baseline);
  }

  const groupA = { ...first, grantedToIdentitiesV2: [{ group: { id: "group-a" } }] };
  const groupB = { ...first, grantedToIdentitiesV2: [{ group: { id: "group-b" } }] };
  assert.notEqual(linkSnapshot([groupA]), linkSnapshot([groupB]));
});

function permission(id, roles, identity) {
  return { grantedToV2: identity, id, roles };
}

function linkPermission({
  id = "generated-link",
  preventsDownload,
  recipients,
  scope,
  type,
  webUrl = "https://secret/generated-link",
}) {
  return {
    grantedToIdentitiesV2: recipients,
    id,
    link: {
      ...(preventsDownload === undefined ? {} : { preventsDownload }),
      scope,
      type,
      webUrl,
    },
    roles: ["read"],
  };
}
