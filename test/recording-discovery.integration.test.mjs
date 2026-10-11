import assert from "node:assert/strict";
import test from "node:test";

import { discoverRecordings } from "../src/recording-discovery.mjs";

test("tenant search paginates and validates organizer recording locations", async () => {
  const fixture = createGraphFixture();
  const result = await discoverRecordings({
    accessToken: token({ roles: ["Files.ReadWrite.All"] }),
    createdAfter: "2026-10-06T12:00:00.000Z",
    fetchImpl: fixture.fetchImpl,
    graphBaseUrl: fixture.baseUrl,
    now: new Date("2026-10-06T12:10:00.000Z"),
    pageSize: 2,
    region: "EUR",
  });

  assert.deepEqual(result, {
    candidates: {
      organizerRecordings: 1,
      otherExcluded: 1,
      searchHits: 3,
      sharePointExcluded: 1,
    },
    pagination: { pages: 2 },
  });
  assert.equal(fixture.searchOffsets.join(","), "0,2");
  assertSanitized(result);
});

test("tenant search fails when a result lacks stable identifiers", async () => {
  const fixture = createGraphFixture({ omitDriveId: true });
  await assertRejectsInvalidData(
    () =>
      discoverRecordings({
        accessToken: token({ roles: ["Files.ReadWrite.All"] }),
        createdAfter: "2026-10-06T12:00:00.000Z",
        fetchImpl: fixture.fetchImpl,
        graphBaseUrl: fixture.baseUrl,
        region: "EUR",
      }),
  );
});

test("Graph errors do not expose response content", async () => {
  const sensitive = "participant@example.test private recording";
  await assert.rejects(
    () =>
      discoverRecordings({
        accessToken: token({ roles: ["Files.ReadWrite.All"] }),
        createdAfter: "2026-10-06T12:00:00.000Z",
        fetchImpl: async () => new Response(sensitive, { status: 500 }),
        graphBaseUrl: "https://graph.test/v1.0",
        region: "EUR",
      }),
    (error) => {
      assert.equal(error.message, "Microsoft Graph request failed with HTTP 500");
      assert.equal(error.message.includes(sensitive), false);
      return true;
    },
  );
});

test("tenant search fails closed on a malformed successful Search response", async () => {
  await assertRejectsInvalidData(
    () =>
      discoverRecordings({
        accessToken: token({ roles: ["Files.ReadWrite.All"] }),
        createdAfter: "2026-10-06T12:00:00.000Z",
        fetchImpl: async () => json(200, {}),
        graphBaseUrl: "https://graph.test/v1.0",
        region: "EUR",
      }),
  );
});

test("tenant search accepts the documented hits container collection", async () => {
  for (const hitsContainers of [
    [],
    [{ moreResultsAvailable: false }],
    [
      { hits: [], moreResultsAvailable: false },
      { hits: [], moreResultsAvailable: false },
    ],
  ]) {
    const result = await discoverRecordings({
      accessToken: token({ roles: ["Files.ReadWrite.All"] }),
      createdAfter: "2026-10-06T12:00:00.000Z",
      fetchImpl: async () => json(200, { value: [{ hitsContainers }] }),
      graphBaseUrl: "https://graph.test/v1.0",
      region: "EUR",
    });

    assert.deepEqual(result, {
      candidates: {
        organizerRecordings: 0,
        otherExcluded: 0,
        searchHits: 0,
        sharePointExcluded: 0,
      },
      pagination: { pages: 1 },
    });
  }
});

test("tenant search rejects invalid container, hit, and pagination data", async (context) => {
  const cases = [
    {
      response: { value: [{ hitsContainers: [null] }] },
      title: "container",
    },
    {
      response: {
        value: [{ hitsContainers: [{ hits: null, moreResultsAvailable: false }] }],
      },
      title: "hits collection",
    },
    {
      response: {
        value: [{ hitsContainers: [{ hits: [{}], moreResultsAvailable: false }] }],
      },
      title: "hit",
    },
    {
      response: {
        value: [{ hitsContainers: [{ hits: [], moreResultsAvailable: true }] }],
      },
      title: "pagination",
    },
  ];

  for (const { response, title } of cases) {
    await context.test(title, async () => {
      await assertRejectsInvalidData(
        () =>
          discoverRecordings({
            accessToken: token({ roles: ["Files.ReadWrite.All"] }),
            createdAfter: "2026-10-06T12:00:00.000Z",
            fetchImpl: async () => json(200, response),
            graphBaseUrl: "https://graph.test/v1.0",
            region: "EUR",
          }),
      );
    });
  }
});

test("tenant search rejects a Drive response for a different identifier", async () => {
  const fixture = createGraphFixture();
  const fetchImpl = async (requestUrl, options) => {
    const path = new URL(requestUrl).pathname;
    if (path === "/v1.0/drives/personal-drive") {
      return json(200, { driveType: "business", id: "different-drive" });
    }
    return fixture.fetchImpl(requestUrl, options);
  };

  await assertRejectsInvalidData(
    () =>
      discoverRecordings({
        accessToken: token({ roles: ["Files.ReadWrite.All"] }),
        createdAfter: "2026-10-06T12:00:00.000Z",
        fetchImpl,
        graphBaseUrl: fixture.baseUrl,
        pageSize: 2,
        region: "EUR",
      }),
  );
});

for (const malformedResource of ["drive", "parent", "permissions"]) {
  test(`tenant search fails closed on a malformed ${malformedResource} response`, async () => {
    const fixture = createGraphFixture();
    const fetchImpl = async (requestUrl, options) => {
      const path = new URL(requestUrl).pathname;
      const isMalformedTarget =
        (malformedResource === "drive" && path === "/v1.0/drives/personal-drive") ||
        (malformedResource === "parent" &&
          path === "/v1.0/drives/personal-drive/items/personal-recordings-folder") ||
        (malformedResource === "permissions" && path.endsWith("/permissions"));
      return isMalformedTarget ? json(200, {}) : fixture.fetchImpl(requestUrl, options);
    };

    await assertRejectsInvalidData(
      () =>
        discoverRecordings({
          accessToken: token({ roles: ["Files.ReadWrite.All"] }),
          createdAfter: "2026-10-06T12:00:00.000Z",
          fetchImpl,
          graphBaseUrl: fixture.baseUrl,
          pageSize: 2,
          region: "EUR",
        }),
    );
  });
}

test("tenant search rejects malformed permission items and pagination", async (context) => {
  for (const { page, title } of [
    {
      page: { value: [{ id: "sensitive-permission", roles: null }] },
      title: "permission item",
    },
    {
      page: { "@odata.nextLink": "https://untrusted.example/next", value: [] },
      title: "permission pagination",
    },
  ]) {
    await context.test(title, async () => {
      const fixture = createGraphFixture();
      const fetchImpl = async (requestUrl, options) => {
        const path = new URL(requestUrl).pathname;
        return path.endsWith("/permissions")
          ? json(200, page)
          : fixture.fetchImpl(requestUrl, options);
      };

      await assertRejectsInvalidData(
        () =>
          discoverRecordings({
            accessToken: token({ roles: ["Files.ReadWrite.All"] }),
            createdAfter: "2026-10-06T12:00:00.000Z",
            fetchImpl,
            graphBaseUrl: fixture.baseUrl,
            pageSize: 2,
            region: "EUR",
          }),
      );
    });
  }
});

function createGraphFixture({ omitDriveId = false } = {}) {
  const searchOffsets = [];
  const items = [
    searchHit({
      createdDateTime: "2026-10-06T12:05:00.000Z",
      driveId: omitDriveId ? undefined : "personal-drive",
      itemId: "organizer-recording",
      parentId: "personal-recordings-folder",
    }),
    searchHit({
      createdDateTime: "2026-10-06T12:04:00.000Z",
      driveId: "channel-drive",
      itemId: "channel-recording",
      parentId: "channel-folder",
    }),
    searchHit({
      createdDateTime: "2026-10-06T12:03:00.000Z",
      driveId: "personal-drive",
      itemId: "ordinary-video",
      parentId: "ordinary-folder",
    }),
  ];

  const fetchImpl = async (requestUrl, options) => {
    assert.equal(options.headers.authorization.startsWith("Bearer "), true);
    const url = new URL(requestUrl);

    if (options.method === "POST" && url.pathname === "/v1.0/search/query") {
      const request = JSON.parse(options.body).requests[0];
      searchOffsets.push(request.from);
      assert.equal(request.region, "EUR");
      assert.deepEqual(request.sharePointOneDriveOptions, {
        includeContent: "privateContent,sharedContent",
      });
      const page = items.slice(request.from, request.from + request.size);
      return json(200, {
        value: [
          {
            hitsContainers: [
              {
                hits: page,
                moreResultsAvailable: request.from + page.length < items.length,
                total: items.length,
              },
            ],
          },
        ],
      });
    }

    const driveMatch = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)$/);
    if (options.method === "GET" && driveMatch) {
      return json(200, {
        driveType: driveMatch[1] === "channel-drive" ? "documentLibrary" : "business",
        id: driveMatch[1],
      });
    }

    const itemMatch = url.pathname.match(/^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)$/);
    if (options.method === "GET" && itemMatch) {
      const parentId = itemMatch[2];
      return json(200, {
        id: parentId,
        ...(parentId.includes("recordings-folder")
          ? { specialFolder: { name: "recordings" } }
          : {}),
      });
    }

    const permissionsMatch = url.pathname.match(
      /^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)\/permissions$/,
    );
    if (options.method === "GET" && permissionsMatch) {
      assert.equal(permissionsMatch[1], "personal-drive");
      assert.equal(permissionsMatch[2], "organizer-recording");
      return json(200, { value: [{ id: "permission-id", roles: ["read"] }] });
    }

    assert.fail(`Unexpected Graph request: ${options.method} ${url.pathname}`);
  };

  return {
    baseUrl: "https://graph.test/v1.0",
    fetchImpl,
    searchOffsets,
  };
}

function searchHit({ createdDateTime, driveId, itemId, parentId }) {
  return {
    hitId: `opaque-${itemId}`,
    resource: {
      createdDateTime,
      id: itemId,
      name: `${itemId}.mp4`,
      parentReference: {
        ...(driveId ? { driveId } : {}),
        id: parentId,
      },
      webUrl: `https://tenant.example/${itemId}`,
    },
  };
}

function assertSanitized(value) {
  const serialized = JSON.stringify(value);
  for (const sensitive of [
    "tenant.example",
    "personal-drive",
    "channel-drive",
    "organizer-recording",
    "permission-id",
  ]) {
    assert.equal(serialized.includes(sensitive), false, `result leaked ${sensitive}`);
  }
}

async function assertRejectsInvalidData(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.message, "Microsoft Graph returned invalid data");
    assertSanitized(error);
    return true;
  });
}

function token(payload) {
  return [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
