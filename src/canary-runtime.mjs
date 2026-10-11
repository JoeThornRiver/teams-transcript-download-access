import { discoverRecordings } from "./recording-discovery.mjs";
import { grantRecordingReadAccess } from "./recording-access.mjs";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MINUTE_MILLISECONDS = 60 * 1000;
const MAX_SEARCH_PAGE_SIZE = 1000;

export function parseCanaryConfig(environment) {
  const clientId = required(environment, "AZURE_CLIENT_ID");
  const searchRegion = required(environment, "MICROSOFT_SEARCH_REGION");
  const storageAccountUrl = required(environment, "WATERMARK_STORAGE_ACCOUNT_URL");
  const timerSchedule = required(environment, "CANARY_TIMER_SCHEDULE");
  const maxLookbackDays = positiveInteger(environment, "MAX_LOOKBACK_DAYS");
  const searchIndexOverlapMinutes = positiveInteger(
    environment,
    "SEARCH_INDEX_OVERLAP_MINUTES",
  );
  const pageSize = positiveInteger(environment, "SEARCH_PAGE_SIZE");

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new Error("AZURE_CLIENT_ID must be a valid UUID");
  }
  if (!/^[A-Z]{3,4}$/.test(searchRegion)) {
    throw new Error("MICROSOFT_SEARCH_REGION must be a three- or four-letter uppercase region code");
  }
  const scheduleFields = timerSchedule.split(/\s+/);
  if (
    scheduleFields.length !== 6 ||
    scheduleFields.some((field) => !/^[0-9A-Za-z*?,/\-]+$/.test(field))
  ) {
    throw new Error("CANARY_TIMER_SCHEDULE must be a six-field NCRONTAB expression");
  }

  if (pageSize > MAX_SEARCH_PAGE_SIZE) {
    throw new Error(`SEARCH_PAGE_SIZE must not exceed ${MAX_SEARCH_PAGE_SIZE}`);
  }

  let storageUrl;
  try {
    storageUrl = new URL(storageAccountUrl);
  } catch {
    throw new Error("WATERMARK_STORAGE_ACCOUNT_URL must be a valid HTTPS URL");
  }
  if (storageUrl.protocol !== "https:") {
    throw new Error("WATERMARK_STORAGE_ACCOUNT_URL must be a valid HTTPS URL");
  }

  return {
    clientId,
    maxLookbackDays,
    pageSize,
    searchIndexOverlapMinutes,
    searchRegion,
    storageAccountUrl: storageUrl.toString().replace(/\/$/, ""),
    timerSchedule,
  };
}

export function computeEffectiveStart({
  currentUtc,
  lastSuccessfulRunUtc,
  maxLookbackDays,
  overlapMinutes,
}) {
  const current = requireValidDate(currentUtc, "currentUtc");
  const lowerBound = new Date(current.getTime() - maxLookbackDays * DAY_MILLISECONDS);
  if (!lastSuccessfulRunUtc) return lowerBound.toISOString();

  const watermark = new Date(lastSuccessfulRunUtc);
  if (Number.isNaN(watermark.getTime()) || watermark.getTime() > current.getTime()) {
    return lowerBound.toISOString();
  }
  const overlappingStart = new Date(watermark.getTime() - overlapMinutes * MINUTE_MILLISECONDS);
  return new Date(Math.max(lowerBound.getTime(), overlappingStart.getTime())).toISOString();
}

export function parseWatermark(value) {
  if (!isObject(value)) return null;
  if (
    Object.keys(value).sort().join(",") !== "lastSuccessfulRunUtc,schemaVersion" ||
    value.schemaVersion !== 1 ||
    typeof value.lastSuccessfulRunUtc !== "string"
  ) {
    return null;
  }
  const timestamp = new Date(value.lastSuccessfulRunUtc);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    schemaVersion: 1,
    lastSuccessfulRunUtc: timestamp.toISOString(),
  };
}

export function createWatermarkPayload(runStart) {
  return {
    schemaVersion: 1,
    lastSuccessfulRunUtc: requireValidDate(runStart, "runStart").toISOString(),
  };
}

export async function runDiscoveryCanary({
  accessToken,
  config,
  fetchImpl = fetch,
  graphBaseUrl,
  now,
  telemetry,
  watermarkStore,
}) {
  const runStart = now ?? new Date();
  const startedAt = runStart.getTime();
  let phase = "watermark-read";

  try {
    const storedWatermark = parseWatermark(await watermarkStore.read());
    const effectiveStart = computeEffectiveStart({
      currentUtc: runStart,
      lastSuccessfulRunUtc: storedWatermark?.lastSuccessfulRunUtc ?? null,
      maxLookbackDays: config.maxLookbackDays,
      overlapMinutes: config.searchIndexOverlapMinutes,
    });

    phase = "discovery";
    const discovery = await discoverRecordings({
      accessToken,
      createdAfter: effectiveStart,
      fetchImpl,
      ...(graphBaseUrl ? { graphBaseUrl } : {}),
      pageSize: config.pageSize,
      processOrganizerRecording: ({ driveId, itemId, permissions }) =>
        grantRecordingReadAccess({
          accessToken,
          beforePermissions: permissions,
          driveId,
          fetchImpl,
          ...(graphBaseUrl ? { graphBaseUrl } : {}),
          itemId,
        }),
      region: config.searchRegion,
    });
    const discoveryState =
      discovery.candidates.searchHits === 0 ? "empty-unverified" : "eligible";
    const durationMilliseconds = Math.max(0, (now ?? new Date()).getTime() - startedAt);
    const operationalResult = {
      counts: discovery.candidates,
      discoveryState,
      durationMilliseconds,
      pages: discovery.pagination.pages,
      watermarkAdvanced: false,
    };

    phase = "telemetry";
    telemetry({
      counts: operationalResult.counts,
      discoveryState,
      durationMilliseconds,
      event: "canary-discovery-completed",
      pages: operationalResult.pages,
    });

    phase = "watermark-write";
    await watermarkStore.write(createWatermarkPayload(runStart));

    const result = { ...operationalResult, watermarkAdvanced: true };
    telemetry({ ...result, event: "canary-run-succeeded" });
    return result;
  } catch (error) {
    telemetry({
      errorCode: classifyError(error, phase),
      event: "canary-run-failed",
      ...(Number.isInteger(error?.graphHttpStatus)
        ? {
            graphErrorCode: error.graphErrorCode ?? "unknown",
            graphErrorMessage: error.graphErrorMessage ?? "unknown",
            graphHttpStatus: error.graphHttpStatus,
          }
        : {}),
      phase,
    });
    throw error;
  }
}

function required(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function positiveInteger(environment, key) {
  const value = required(environment, key);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Number(value);
}

function requireValidDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date;
}

function classifyError(error, phase) {
  const message = error instanceof Error ? error.message : "";
  const statusMatch = message.match(/HTTP (\d{3})$/);
  if (statusMatch?.[1] === "401" || statusMatch?.[1] === "403") {
    return "graph-authorization-failed";
  }
  if (statusMatch) return "graph-request-failed";
  if (phase === "watermark-read") return "watermark-read-failed";
  if (phase === "watermark-write") return "watermark-write-failed";
  if (phase === "telemetry") return "telemetry-failed";
  return "canary-run-failed";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
