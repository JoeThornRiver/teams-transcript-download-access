import assert from "node:assert/strict";
import test from "node:test";

import { runDiscoveryCanary } from "../src/canary-runtime.mjs";

const config = {
  clientId: "11111111-1111-4111-8111-111111111111",
  maxLookbackDays: 14,
  pageSize: 2,
  searchIndexOverlapMinutes: 30,
  searchRegion: "DEU",
  storageAccountUrl: "https://recordingstate.blob.core.windows.net",
  timerSchedule: "0 */5 * * * *",
};

test("canary completes multi-page discovery, classifies locations, and persists run start", async () => {
  const graph = createGraphFixture();
  const store = createWatermarkStore({
    schemaVersion: 1,
    lastSuccessfulRunUtc: "2026-10-06T11:55:00.000Z",
  });
  const telemetry = [];

  const result = await runDiscoveryCanary({
    accessToken: token({ roles: ["Files.ReadWrite.All"] }),
    config,
    fetchImpl: graph.fetchImpl,
    graphBaseUrl: graph.baseUrl,
    now: new Date("2026-10-06T12:00:00.000Z"),
    telemetry: (event) => telemetry.push(event),
    watermarkStore: store,
  });

  assert.deepEqual(result, {
    counts: {
      organizerRecordings: 1,
      otherExcluded: 0,
      searchHits: 2,
      sharePointExcluded: 1,
    },
    discoveryState: "eligible",
    durationMilliseconds: 0,
    pages: 2,
    watermarkAdvanced: true,
  });
  assert.deepEqual(store.writes, [
    {
      schemaVersion: 1,
      lastSuccessfulRunUtc: "2026-10-06T12:00:00.000Z",
    },
  ]);
  assert.equal(graph.searchOffsets.join(","), "0,1");
  assert.deepEqual(
    graph.requests.map(({ method, pathname }) => `${method} ${pathname}`),
    [
      "POST /v1.0/search/query",
      "POST /v1.0/search/query",
      "GET /v1.0/drives/personal-drive",
      "GET /v1.0/drives/personal-drive/items/personal-recordings-folder",
      "GET /v1.0/drives/personal-drive/items/organizer-recording/permissions",
      "POST /v1.0/drives/personal-drive/items/organizer-recording/invite",
      "GET /v1.0/drives/personal-drive/items/organizer-recording/permissions",
      "GET /v1.0/drives/channel-drive",
      "GET /v1.0/drives/channel-drive/items/channel-folder",
    ],
  );
  assert.deepEqual(graph.invites, [
    {
      recipients: [{ objectId: "existing-recipient" }],
      requireSignIn: true,
      retainInheritedPermissions: true,
      roles: ["read"],
      sendInvitation: false,
    },
  ]);
  assert.equal(telemetry.at(-1).event, "canary-run-succeeded");
  assertSanitized({ result, telemetry, writes: store.writes });
});

test("a repeated timer run does not grant duplicate direct access", async () => {
  const graph = createGraphFixture({
    expectedBoundary: ["2026-09-22T12:00:00.000Z", "2026-10-06T11:30:00.000Z"],
    items: [
      searchHit({
        driveId: "personal-drive",
        itemId: "organizer-recording",
        parentId: "personal-recordings-folder",
      }),
    ],
  });
  const store = createWatermarkStore();

  for (const now of ["2026-10-06T12:00:00.000Z", "2026-10-06T12:05:00.000Z"]) {
    await runDiscoveryCanary({
      accessToken: token({ roles: ["Files.ReadWrite.All"] }),
      config,
      fetchImpl: graph.fetchImpl,
      graphBaseUrl: graph.baseUrl,
      now: new Date(now),
      telemetry: () => {},
      watermarkStore: store,
    });
  }

  assert.equal(graph.invites.length, 1);
  assert.equal(store.writes.length, 2);
});

test("empty private-content Search is reported as empty-unverified", async () => {
  const store = createWatermarkStore();
  const result = await runDiscoveryCanary({
    accessToken: token({ roles: ["Files.ReadWrite.All"] }),
    config,
    fetchImpl: createGraphFixture({
      expectedBoundary: "2026-09-22T12:00:00.000Z",
      items: [],
    }).fetchImpl,
    graphBaseUrl: "https://graph.test/v1.0",
    now: new Date("2026-10-06T12:00:00.000Z"),
    telemetry: () => {},
    watermarkStore: store,
  });

  assert.equal(result.discoveryState, "empty-unverified");
  assert.equal(store.writes.length, 1);
});

test("future watermark falls back to bounded catch-up and is replaced by run start", async () => {
  const store = createWatermarkStore({
    schemaVersion: 1,
    lastSuccessfulRunUtc: "2099-01-01T00:00:00.000Z",
  });
  const graph = createGraphFixture({
    expectedBoundary: "2026-09-22T12:00:00.000Z",
    items: [],
  });

  await runDiscoveryCanary({
    accessToken: token({ roles: ["Files.ReadWrite.All"] }),
    config,
    fetchImpl: graph.fetchImpl,
    graphBaseUrl: graph.baseUrl,
    now: new Date("2026-10-06T12:00:00.000Z"),
    telemetry: () => {},
    watermarkStore: store,
  });

  assert.deepEqual(store.writes, [
    {
      schemaVersion: 1,
      lastSuccessfulRunUtc: "2026-10-06T12:00:00.000Z",
    },
  ]);
});

for (const [scenario, expectedErrorCode] of [
  ["graph-error", "graph-request-failed"],
  ["search-json", "canary-run-failed"],
  ["search-envelope", "canary-run-failed"],
  ["search-container", "canary-run-failed"],
  ["search-hit", "canary-run-failed"],
  ["search-pagination", "canary-run-failed"],
  ["drive", "canary-run-failed"],
  ["drive-json", "canary-run-failed"],
  ["parent", "canary-run-failed"],
  ["parent-json", "canary-run-failed"],
  ["permissions-page", "canary-run-failed"],
  ["permissions-json", "canary-run-failed"],
  ["permission-item", "canary-run-failed"],
  ["invite", "graph-request-failed"],
  ["watermark-write", "watermark-write-failed"],
]) {
  test(`${scenario} failure does not advance the watermark`, async () => {
    const graph = createGraphFixture({
      expectedBoundary: "2026-09-22T12:00:00.000Z",
      graphError: scenario === "graph-error",
      malformedScenario: scenario,
    });
    const store = createWatermarkStore(undefined, {
      failWrite: scenario === "watermark-write",
    });
    const telemetry = [];

    await assert.rejects(() =>
      runDiscoveryCanary({
        accessToken: token({ roles: ["Files.ReadWrite.All"] }),
        config,
        fetchImpl: graph.fetchImpl,
        graphBaseUrl: graph.baseUrl,
        now: new Date("2026-10-06T12:00:00.000Z"),
        telemetry: (event) => telemetry.push(event),
        watermarkStore: store,
      }),
    );

    assert.equal(store.writes.length, 0);
    const sanitizedGraphMessagePrefix =
      "Invalid request for [redacted] at [redacted] or [redacted] with id [redacted]. ";
    assert.deepEqual(telemetry.at(-1), {
      errorCode: expectedErrorCode,
      event: "canary-run-failed",
      ...(scenario === "graph-error"
        ? {
            graphErrorCode: "BadRequest",
            graphErrorMessage:
              sanitizedGraphMessagePrefix +
              "x".repeat(300 - sanitizedGraphMessagePrefix.length),
            graphHttpStatus: 503,
          }
        : {}),
      phase: scenario === "watermark-write" ? "watermark-write" : "discovery",
    });
    assertSanitized(telemetry);
  });
}

function createWatermarkStore(initialValue, { failWrite = false } = {}) {
  const writes = [];
  return {
    writes,
    async read() {
      return writes.at(-1) ?? initialValue;
    },
    async write(value) {
      if (failWrite) throw new Error("watermark write failed");
      writes.push(value);
    },
  };
}

function createGraphFixture({
  expectedBoundary = "2026-10-06T11:25:00.000Z",
  graphError = false,
  items,
  malformedScenario,
} = {}) {
  const searchOffsets = [];
  const requests = [];
  const invites = [];
  let directAccessGranted = false;
  const expectedBoundaries = Array.isArray(expectedBoundary)
    ? expectedBoundary
    : [expectedBoundary];
  const searchItems =
    items ??
    [
      searchHit({
        driveId: "personal-drive",
        itemId: "organizer-recording",
        parentId: "personal-recordings-folder",
      }),
      searchHit({
        driveId: "channel-drive",
        itemId: "channel-recording",
        parentId: "channel-folder",
      }),
    ];

  const fetchImpl = async (requestUrl, options) => {
    const url = new URL(requestUrl);
    requests.push({ method: options.method, pathname: url.pathname });
    if (options.method === "POST" && url.pathname === "/v1.0/search/query") {
      if (graphError) {
        return json(503, {
          error: {
            code: "BadRequest",
            message:
              "Invalid request for participant@example.test at " +
              "https://tenant.example/path or ftp://tenant.example/private with id " +
              "01890f3e-7b5a-7cc1-98c4-dc0c0c07398f.\n" +
              "x".repeat(400),
          },
        });
      }
      if (malformedScenario === "search-json") return malformedJson();
      if (malformedScenario === "search-envelope") return json(200, { value: [] });
      const request = JSON.parse(options.body).requests[0];
      searchOffsets.push(request.from);
      const boundaryIndex = Math.min(searchOffsets.length - 1, expectedBoundaries.length - 1);
      assert.equal(
        request.query.queryString,
        `filetype:mp4 AND Created>${expectedBoundaries[boundaryIndex]}`,
      );
      const page =
        malformedScenario === "search-hit"
          ? [{}]
          : malformedScenario === "search-pagination"
            ? []
            : searchItems.slice(request.from, request.from + 1);
      return json(200, {
        value: [
          {
            hitsContainers: malformedScenario === "search-container"
              ? [null]
              : [
                  {
                    hits: page,
                    moreResultsAvailable:
                      malformedScenario === "search-pagination" ||
                      request.from + page.length < searchItems.length,
                  },
                ],
          },
        ],
      });
    }

    const driveMatch = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)$/);
    if (options.method === "GET" && driveMatch) {
      if (malformedScenario === "drive-json") return malformedJson();
      if (malformedScenario === "drive") return json(200, {});
      return json(200, {
        driveType: driveMatch[1] === "channel-drive" ? "documentLibrary" : "business",
        id: driveMatch[1],
      });
    }

    const itemMatch = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)$/);
    if (options.method === "GET" && itemMatch) {
      if (malformedScenario === "parent-json") return malformedJson();
      if (malformedScenario === "parent") return json(200, {});
      return json(200, {
        id: itemMatch[2],
        ...(itemMatch[2] === "personal-recordings-folder"
          ? { specialFolder: { name: "recordings" } }
          : {}),
      });
    }

    if (options.method === "GET" && url.pathname.endsWith("/permissions")) {
      if (malformedScenario === "permissions-json") return malformedJson();
      if (malformedScenario === "permissions-page") return json(200, {});
      if (malformedScenario === "permission-item") {
        return json(200, { value: [{ id: "permission-id", roles: null }] });
      }
      return json(200, {
        value: [
          ...(directAccessGranted
            ? [{
                grantedToV2: { user: { id: "existing-recipient" } },
                id: "direct-read",
                roles: ["read"],
              }]
            : []),
          {
            grantedToIdentitiesV2: [{ user: { id: "existing-recipient" } }],
            id: "permission-id",
            link: { preventsDownload: true, scope: "users", type: "view" },
            roles: ["read"],
          },
        ],
      });
    }

    if (options.method === "POST" && url.pathname.endsWith("/invite")) {
      if (malformedScenario === "invite") return json(503, {});
      const body = JSON.parse(options.body);
      invites.push(body);
      directAccessGranted = true;
      return json(200, { value: [] });
    }

    assert.fail(`Unexpected Graph request: ${options.method} ${url.pathname}`);
  };

  return { baseUrl: "https://graph.test/v1.0", fetchImpl, invites, requests, searchOffsets };
}

function searchHit({ driveId, itemId, parentId }) {
  return {
    resource: {
      createdDateTime: "2026-10-06T11:59:00.000Z",
      id: itemId,
      name: "Private meeting.mp4",
      parentReference: { driveId, id: parentId },
      webUrl: `https://tenant.example/${itemId}`,
    },
  };
}

function assertSanitized(value) {
  const serialized = JSON.stringify(value);
  for (const sensitive of [
    "participant@example.test",
    "Private meeting",
    "tenant.example",
    "personal-drive",
    "channel-drive",
    "organizer-recording",
    "permission-id",
  ]) {
    assert.equal(serialized.includes(sensitive), false, `output leaked ${sensitive}`);
  }
}

function token(payload) {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function malformedJson() {
  return new Response('{"private":"participant@example.test"', {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
