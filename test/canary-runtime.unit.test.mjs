import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { createBlobWatermarkStore } from "../src/azure-runtime.mjs";
import {
  computeEffectiveStart,
  createWatermarkPayload,
  parseCanaryConfig,
  parseWatermark,
} from "../src/canary-runtime.mjs";

const validEnvironment = {
  AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  CANARY_TIMER_SCHEDULE: "0 */5 * * * *",
  MAX_LOOKBACK_DAYS: "14",
  MICROSOFT_SEARCH_REGION: "EMEA",
  SEARCH_INDEX_OVERLAP_MINUTES: "30",
  SEARCH_PAGE_SIZE: "100",
  WATERMARK_STORAGE_ACCOUNT_URL: "https://recordingstate.blob.core.windows.net",
};

test("parseCanaryConfig accepts the supported deployment settings", () => {
  assert.deepEqual(parseCanaryConfig(validEnvironment), {
    clientId: validEnvironment.AZURE_CLIENT_ID,
    maxLookbackDays: 14,
    pageSize: 100,
    searchIndexOverlapMinutes: 30,
    searchRegion: "EMEA",
    storageAccountUrl: validEnvironment.WATERMARK_STORAGE_ACCOUNT_URL,
    timerSchedule: validEnvironment.CANARY_TIMER_SCHEDULE,
  });
});

test("parseCanaryConfig rejects missing, malformed, zero, negative, and unsupported values", () => {
  for (const key of Object.keys(validEnvironment)) {
    assert.throws(
      () => parseCanaryConfig({ ...validEnvironment, [key]: "" }),
      new RegExp(key),
    );
  }

  for (const [key, value] of [
    ["MAX_LOOKBACK_DAYS", "not-a-number"],
    ["MAX_LOOKBACK_DAYS", "0"],
    ["MAX_LOOKBACK_DAYS", "-1"],
    ["SEARCH_INDEX_OVERLAP_MINUTES", "0"],
    ["SEARCH_INDEX_OVERLAP_MINUTES", "-1"],
    ["SEARCH_PAGE_SIZE", "0"],
    ["SEARCH_PAGE_SIZE", "1001"],
  ]) {
    assert.throws(() => parseCanaryConfig({ ...validEnvironment, [key]: value }));
  }

  assert.throws(
    () =>
      parseCanaryConfig({
        ...validEnvironment,
        WATERMARK_STORAGE_ACCOUNT_URL: "http://recordingstate.blob.core.windows.net",
      }),
    /WATERMARK_STORAGE_ACCOUNT_URL/,
  );
  assert.throws(
    () => parseCanaryConfig({ ...validEnvironment, AZURE_CLIENT_ID: "not-a-uuid" }),
    /AZURE_CLIENT_ID/,
  );
  assert.equal(
    parseCanaryConfig({ ...validEnvironment, MICROSOFT_SEARCH_REGION: "DEU" }).searchRegion,
    "DEU",
  );
  for (const region of ["deu", "EU", "EUROPE"]) {
    assert.throws(
      () => parseCanaryConfig({ ...validEnvironment, MICROSOFT_SEARCH_REGION: region }),
      /MICROSOFT_SEARCH_REGION/,
    );
  }
  assert.throws(
    () => parseCanaryConfig({ ...validEnvironment, CANARY_TIMER_SCHEDULE: "every five minutes" }),
    /CANARY_TIMER_SCHEDULE/,
  );
});

test("computeEffectiveStart uses the maximum lookback when no valid watermark exists", () => {
  assert.equal(
    computeEffectiveStart({
      currentUtc: new Date("2026-10-06T12:00:00.000Z"),
      lastSuccessfulRunUtc: null,
      maxLookbackDays: 14,
      overlapMinutes: 30,
    }),
    "2026-09-22T12:00:00.000Z",
  );
});

test("computeEffectiveStart applies overlap but never exceeds the maximum lookback", () => {
  assert.equal(
    computeEffectiveStart({
      currentUtc: new Date("2026-10-06T12:00:00.000Z"),
      lastSuccessfulRunUtc: "2026-10-06T11:55:00.000Z",
      maxLookbackDays: 14,
      overlapMinutes: 30,
    }),
    "2026-10-06T11:25:00.000Z",
  );

  assert.equal(
    computeEffectiveStart({
      currentUtc: new Date("2026-10-06T12:00:00.000Z"),
      lastSuccessfulRunUtc: "2026-01-01T00:00:00.000Z",
      maxLookbackDays: 14,
      overlapMinutes: 30,
    }),
    "2026-09-22T12:00:00.000Z",
  );
});

test("computeEffectiveStart treats a future watermark as invalid", () => {
  assert.equal(
    computeEffectiveStart({
      currentUtc: new Date("2026-10-06T12:00:00.000Z"),
      lastSuccessfulRunUtc: "2099-01-01T00:00:00.000Z",
      maxLookbackDays: 14,
      overlapMinutes: 30,
    }),
    "2026-09-22T12:00:00.000Z",
  );
});

test("watermark parsing accepts only the complete schema and writes the run start", () => {
  assert.deepEqual(
    parseWatermark({
      schemaVersion: 1,
      lastSuccessfulRunUtc: "2026-10-06T11:55:00.000Z",
    }),
    { schemaVersion: 1, lastSuccessfulRunUtc: "2026-10-06T11:55:00.000Z" },
  );
  assert.equal(parseWatermark(undefined), null);
  assert.equal(parseWatermark({ schemaVersion: 2, lastSuccessfulRunUtc: "2026-10-06" }), null);
  assert.equal(
    parseWatermark({
      schemaVersion: 1,
      lastSuccessfulRunUtc: "2026-10-06T11:55:00.000Z",
      participant: "participant@example.test",
    }),
    null,
  );
  assert.deepEqual(createWatermarkPayload(new Date("2026-10-06T12:00:00.000Z")), {
    schemaVersion: 1,
    lastSuccessfulRunUtc: "2026-10-06T12:00:00.000Z",
  });
});

test("blob watermark store uses only the declared state artifact", async () => {
  const uploads = [];
  const store = createBlobWatermarkStore({
    async download() {
      return {
        readableStreamBody: Readable.from([
          '{"schemaVersion":1,"lastSuccessfulRunUtc":"2026-10-06T11:55:00.000Z"}',
        ]),
      };
    },
    async upload(content, length, options) {
      uploads.push({ content, length, options });
    },
  });

  assert.deepEqual(await store.read(), {
    schemaVersion: 1,
    lastSuccessfulRunUtc: "2026-10-06T11:55:00.000Z",
  });
  await store.write({
    schemaVersion: 1,
    lastSuccessfulRunUtc: "2026-10-06T12:00:00.000Z",
  });
  assert.deepEqual(uploads, [
    {
      content: '{"schemaVersion":1,"lastSuccessfulRunUtc":"2026-10-06T12:00:00.000Z"}',
      length: 69,
      options: { blobHTTPHeaders: { blobContentType: "application/json" } },
    },
  ]);
});
