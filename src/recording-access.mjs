import { createHash } from "node:crypto";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const SUFFICIENT_ROLES = new Set(["owner", "write", "read"]);

export function selectBlockedDownloadRecipients(permissions) {
  const recipients = [];
  const claimedKeys = new Set();

  for (const permission of permissions) {
    if (!isSpecificPeopleDownloadBlockedLink(permission?.link)) {
      continue;
    }
    const identities = [
      ...(permission?.grantedToIdentitiesV2 ?? []),
      ...(permission?.grantedToIdentities ?? []),
    ];
    for (const identity of identities) {
      const candidate = recipientFromIdentity(identity);
      if (!candidate || candidate.keys.some((key) => claimedKeys.has(key))) continue;
      candidate.keys.forEach((key) => claimedKeys.add(key));
      recipients.push(candidate);
    }
  }

  return recipients;
}

export function directAccessKeys(permissions) {
  const keys = new Set();
  for (const permission of permissions) {
    if (permission?.link || permission?.inheritedFrom) continue;
    const sufficient = permission?.roles?.some((role) =>
      SUFFICIENT_ROLES.has(role.toLowerCase()));
    if (!sufficient) continue;
    permissionRecipientKeys(permission).forEach((key) => keys.add(key));
  }
  return keys;
}

export function linkSnapshot(permissions) {
  const links = permissions
    .filter((permission) => permission?.link)
    .map(stableStringify)
    .sort();
  return createHash("sha256").update(JSON.stringify(links)).digest("hex");
}

export async function grantRecordingReadAccess(options) {
  const {
    accessToken,
    beforePermissions: suppliedBeforePermissions,
    driveId,
    fetchImpl = fetch,
    graphBaseUrl = DEFAULT_GRAPH_BASE_URL,
    itemId,
  } = options;

  if (!accessToken) throw new Error("GRAPH_ACCESS_TOKEN is required");
  if (!driveId || !itemId) throw new Error("driveId and itemId are required");

  const graph = createGraphClient({ accessToken, fetchImpl, graphBaseUrl });

  const permissionsPath =
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/permissions`;
  const beforePermissions = suppliedBeforePermissions ?? await graph.getCollection(permissionsPath);
  const recipients = selectBlockedDownloadRecipients(beforePermissions);

  const beforeLinks = linkSnapshot(beforePermissions);
  const beforeDirect = directAccessKeys(beforePermissions);
  const preexistingDirect = directPermissionSignatures(beforePermissions);
  const missing = recipients.filter(
    (recipient) => !recipient.keys.some((key) => beforeDirect.has(key)),
  );

  if (missing.length > 0) {
    await graph.post(
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/invite`,
      {
        recipients: missing.map(({ invite }) => invite),
        requireSignIn: true,
        retainInheritedPermissions: true,
        roles: ["read"],
        sendInvitation: false,
      },
    );
  }

  const afterPermissions = missing.length > 0
    ? await graph.getCollection(permissionsPath)
    : beforePermissions;
  const afterLinks = linkSnapshot(afterPermissions);
  if (afterLinks !== beforeLinks) {
    throw new Error(
      "Generated sharing-link state changed; inspect the recording immediately and do not continue",
    );
  }

  const afterDirect = directAccessKeys(afterPermissions);
  const afterDirectSignatures = directPermissionSignatures(afterPermissions);
  if ([...preexistingDirect].some((signature) => !afterDirectSignatures.has(signature))) {
    throw new Error("A pre-existing direct permission changed; inspect the recording immediately");
  }

  const stillMissing = recipients.filter(
    (recipient) => !recipient.keys.some((key) => afterDirect.has(key)),
  );
  if (stillMissing.length > 0) {
    throw new Error("Direct read access could not be verified for every selected recipient");
  }
  const invalidNewGrants = missing.filter(
    (recipient) => !hasExactDirectReadPermission(afterPermissions, recipient),
  );
  if (invalidNewGrants.length > 0) {
    throw new Error("A newly granted recipient permission was not read-only");
  }
}

function recipientFromIdentity(identity) {
  const objectId = normalize(identity?.user?.id);
  const email = emailFromIdentity(identity);
  const keys = [objectId && `id:${objectId}`, email && `email:${email}`].filter(Boolean);
  if (keys.length === 0) return undefined;
  return {
    invite: objectId ? { objectId } : { email },
    keys,
  };
}

function permissionRecipientKeys(permission) {
  const identities = [
    permission?.grantedToV2,
    permission?.grantedTo,
    ...(permission?.grantedToIdentitiesV2 ?? []),
    ...(permission?.grantedToIdentities ?? []),
  ];
  const rootInvitationEmail = normalizeEmail(permission?.invitation?.email);
  return [
    ...new Set(
      [rootInvitationEmail && `email:${rootInvitationEmail}`,
      ...identities.flatMap((identity) => {
        const objectId = normalize(identity?.user?.id);
        const email = emailFromIdentity(identity);
        return [objectId && `id:${objectId}`, email && `email:${email}`].filter(Boolean);
      })].filter(Boolean),
    ),
  ];
}

function emailFromIdentity(identity) {
  return normalizeEmail(
    identity?.user?.email ??
      identity?.siteUser?.email ??
      identity?.invitation?.email ??
      identity?.siteUser?.loginName,
  );
}

function normalizeEmail(value) {
  const normalized = normalize(value);
  if (!normalized) return undefined;
  const candidate = normalized.includes("|") ? normalized.split("|").at(-1) : normalized;
  return candidate.includes("@") ? candidate : undefined;
}

function directPermissionSignatures(permissions) {
  return new Set(
    permissions
      .filter((permission) => !permission?.link && !permission?.inheritedFrom)
      .map(stableStringify),
  );
}

function hasExactDirectReadPermission(permissions, recipient) {
  return permissions.some((permission) => {
    if (permission?.link || permission?.inheritedFrom) return false;
    const roles = (permission.roles ?? []).map((role) => role.toLowerCase());
    if (roles.length !== 1 || roles[0] !== "read") return false;
    const identities = [
      permission?.grantedToV2,
      permission?.grantedTo,
      ...(permission?.grantedToIdentitiesV2 ?? []),
      ...(permission?.grantedToIdentities ?? []),
    ].filter(Boolean);
    if (identities.length === 0) {
      const email = normalizeEmail(permission?.invitation?.email);
      return email ? recipient.keys.includes(`email:${email}`) : false;
    }
    return identities.every((identity) => {
      const keys = identityRecipientKeys(identity);
      return keys.length > 0 && keys.some((key) => recipient.keys.includes(key));
    });
  });
}

function createGraphClient({ accessToken, fetchImpl, graphBaseUrl }) {
  const baseUrl = new URL(graphBaseUrl.endsWith("/") ? graphBaseUrl : `${graphBaseUrl}/`);

  async function request(method, pathOrUrl, body) {
    const url = new URL(pathOrUrl.replace(/^\//, ""), baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
      throw new Error("Microsoft Graph pagination returned an unexpected URL");
    }
    let response;
    try {
      response = await fetchImpl(url, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
      });
    } catch {
      throw new Error("Microsoft Graph request failed before a response was received");
    }
    if (!response.ok) {
      throw new Error(`Microsoft Graph request failed with HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  return {
    async getCollection(path) {
      const values = [];
      let next = path;
      while (next) {
        const page = await request("GET", next);
        if (!Array.isArray(page?.value)) {
          throw new Error("Microsoft Graph returned an invalid collection response");
        }
        values.push(...page.value);
        next = page["@odata.nextLink"];
      }
      return values;
    },
    post: (path, body) => request("POST", path, body),
  };
}

function normalize(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function isSpecificPeopleDownloadBlockedLink(link) {
  return (
    link?.scope === "users" &&
    (link?.type === "blocksDownload" ||
      (link?.type === "view" && link?.preventsDownload === true))
  );
}

function identityRecipientKeys(identity) {
  const objectId = normalize(identity?.user?.id);
  const email = emailFromIdentity(identity);
  return [objectId && `id:${objectId}`, email && `email:${email}`].filter(Boolean);
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
