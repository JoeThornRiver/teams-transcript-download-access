const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_PAGE_SIZE = 100;
export function assertApplicationToken(accessToken) {
  const segments = accessToken?.split(".");
  if (segments?.length !== 3) throw new Error("GRAPH_ACCESS_TOKEN must be a valid JWT");

  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("GRAPH_ACCESS_TOKEN must be a valid JWT");
  }

  if (typeof claims.scp === "string" && claims.scp.trim()) {
    throw new Error("GRAPH_ACCESS_TOKEN must be an application token, not a delegated token");
  }
  if (
    !Array.isArray(claims.roles) ||
    claims.roles.length !== 1 ||
    claims.roles[0] !== "Files.ReadWrite.All"
  ) {
    throw new Error(
      "GRAPH_ACCESS_TOKEN must contain only the Files.ReadWrite.All application role",
    );
  }
}

export function buildSearchRequest({ createdAfter, from, region, size }) {
  return {
    requests: [
      {
        entityTypes: ["driveItem"],
        fields: ["id", "parentReference"],
        from,
        query: {
          queryString: `filetype:mp4 AND Created>${createdAfter}`,
        },
        region,
        sharePointOneDriveOptions: {
          includeContent: "privateContent,sharedContent",
        },
        size,
      },
    ],
  };
}

export function isOrganizerRecordingLocation({ drive, parent }) {
  return (
    drive?.driveType === "business" &&
    parent?.specialFolder?.name?.toLowerCase() === "recordings"
  );
}

export async function discoverRecordings(options) {
  const {
    accessToken,
    createdAfter,
    fetchImpl = fetch,
    graphBaseUrl = DEFAULT_GRAPH_BASE_URL,
    pageSize = DEFAULT_PAGE_SIZE,
    processOrganizerRecording,
    region,
  } = options;

  assertApplicationToken(accessToken);
  if (!region?.trim()) throw new Error("region is required");
  const cutoff = new Date(createdAfter);
  if (Number.isNaN(cutoff.getTime())) throw new Error("createdAfter must be a valid timestamp");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error("pageSize must be an integer between 1 and 1000");
  }

  const graph = createGraphClient({ accessToken, fetchImpl, graphBaseUrl });
  const hits = [];
  let from = 0;
  let pages = 0;

  while (true) {
    const response = await graph.post("/search/query", buildSearchRequest({
        createdAfter: cutoff.toISOString(),
        from,
        region: region.trim(),
        size: pageSize,
      }));
    pages += 1;
    const containers = validateSearchResponse(response);
    const pageHits = containers.flatMap((container) => container.hits ?? []);
    hits.push(...pageHits);
    const moreResultsAvailable = containers.some(
      (container) => container?.moreResultsAvailable === true,
    );
    if (!moreResultsAvailable) break;
    if (pageHits.length === 0) {
      throw invalidGraphResponse();
    }
    from += pageHits.length;
  }

  const counts = {
    organizerRecordings: 0,
    otherExcluded: 0,
    searchHits: hits.length,
    sharePointExcluded: 0,
  };
  for (const hit of hits) {
    const resource = hit?.resource;
    const driveId = resource?.parentReference?.driveId;
    const itemId = resource?.id;
    const parentId = resource?.parentReference?.id;
    if (!driveId || !itemId || !parentId) {
      throw invalidGraphResponse();
    }

    const [drive, parent] = await Promise.all([
      graph.get(`/drives/${encodeURIComponent(driveId)}?$select=id,driveType`),
      graph.get(
        `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}` +
          "?$select=id,specialFolder",
      ),
    ]);
    validateDriveResponse(drive, driveId);
    validateParentResponse(parent, parentId);

    if (isOrganizerRecordingLocation({ drive, parent })) {
      const permissions = await graph.getCollection(
        `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/permissions`,
        validatePermission,
      );
      if (processOrganizerRecording) {
        await processOrganizerRecording({ driveId, itemId, permissions });
      }
      counts.organizerRecordings += 1;
    } else if (drive?.driveType === "documentLibrary") {
      counts.sharePointExcluded += 1;
    } else {
      counts.otherExcluded += 1;
    }
  }

  return {
    candidates: counts,
    pagination: { pages },
  };
}

function createGraphClient({ accessToken, fetchImpl, graphBaseUrl }) {
  async function request(method, path, body) {
    const response = await fetchImpl(`${graphBaseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
    });
    if (!response.ok) {
      const graphError = await readGraphError(response);
      const error = new Error(`Microsoft Graph request failed with HTTP ${response.status}`);
      error.graphHttpStatus = response.status;
      error.graphErrorCode = graphError.code;
      error.graphErrorMessage = graphError.message;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      throw invalidGraphResponse();
    }
  }

  return {
    get: (path) => request("GET", path),
    async getCollection(path, validateItem) {
      const values = [];
      let nextPath = path;
      while (nextPath) {
        const page = await request("GET", nextPath);
        if (!isObject(page) || !Array.isArray(page.value)) {
          throw invalidGraphResponse();
        }
        for (const item of page.value) validateItem(item);
        values.push(...page.value);
        const nextLink = page["@odata.nextLink"];
        if (
          nextLink !== undefined &&
          (typeof nextLink !== "string" || !nextLink.startsWith(`${graphBaseUrl}/`))
        ) {
          throw invalidGraphResponse();
        }
        nextPath = nextLink ? nextLink.slice(graphBaseUrl.length) : undefined;
      }
      return values;
    },
    post: (path, body) => request("POST", path, body),
  };
}

async function readGraphError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return { code: "unknown", message: "unknown" };
  }
  const code = body?.error?.code;
  const message = body?.error?.message;
  const sanitizedMessage = typeof message === "string"
    ? message
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]")
        .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+/g, "[redacted]")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[redacted]")
        .trim()
        .slice(0, 300)
    : "";
  return {
    code: typeof code === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(code)
      ? code
      : "unknown",
    message: sanitizedMessage || "unknown",
  };
}

function validateSearchResponse(response) {
  if (!isObject(response) || !Array.isArray(response.value) || response.value.length !== 1) {
    throw invalidGraphResponse();
  }

  const entry = response.value[0];
  if (!isObject(entry) || !Array.isArray(entry.hitsContainers)) {
    throw invalidGraphResponse();
  }

  for (const container of entry.hitsContainers) {
    if (
      !isObject(container) ||
      (container.hits !== undefined && !Array.isArray(container.hits))
    ) {
      throw invalidGraphResponse();
    }
    if (typeof container.moreResultsAvailable !== "boolean") {
      throw invalidGraphResponse();
    }
    for (const hit of container.hits ?? []) {
      if (
        !isObject(hit) ||
        !isObject(hit.resource) ||
        !isNonEmptyString(hit.resource.id) ||
        !isObject(hit.resource.parentReference) ||
        !isNonEmptyString(hit.resource.parentReference.driveId) ||
        !isNonEmptyString(hit.resource.parentReference.id)
      ) {
        throw invalidGraphResponse();
      }
    }
  }

  return entry.hitsContainers;
}

function validateDriveResponse(drive, expectedId) {
  if (
    !isObject(drive) ||
    drive.id !== expectedId ||
    !isNonEmptyString(drive.driveType)
  ) {
    throw invalidGraphResponse();
  }
}

function validateParentResponse(parent, expectedId) {
  if (!isObject(parent) || parent.id !== expectedId) {
    throw invalidGraphResponse();
  }
  if (
    parent.specialFolder !== undefined &&
    (!isObject(parent.specialFolder) || !isNonEmptyString(parent.specialFolder.name))
  ) {
    throw invalidGraphResponse();
  }
}

function validatePermission(permission) {
  if (
    !isObject(permission) ||
    !isNonEmptyString(permission.id) ||
    !Array.isArray(permission.roles) ||
    !permission.roles.every(isNonEmptyString)
  ) {
    throw invalidGraphResponse();
  }
}

function invalidGraphResponse() {
  return new Error("Microsoft Graph returned invalid data");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
