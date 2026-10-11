import { app } from "@azure/functions";

import { createAzureBlobWatermarkStore, createManagedIdentityTokenProvider } from "../azure-runtime.mjs";
import { parseCanaryConfig, runDiscoveryCanary } from "../canary-runtime.mjs";

export async function recordingDiscoveryCanary(_timer, context) {
  let phase = "configuration";
  try {
    const config = parseCanaryConfig(process.env);
    const tokenProvider = createManagedIdentityTokenProvider(config.clientId);
    const watermarkStore = createAzureBlobWatermarkStore({
      accountUrl: config.storageAccountUrl,
      credential: tokenProvider.credential,
    });

    phase = "managed-identity-token";
    const accessToken = await tokenProvider.getGraphAccessToken();
    phase = "canary-run";
    return await runDiscoveryCanary({
      accessToken,
      config,
      telemetry: (event) => context.log(JSON.stringify(event)),
      watermarkStore,
    });
  } catch {
    context.error(JSON.stringify({
      errorCode: "canary-invocation-failed",
      event: "canary-invocation-failed",
      phase,
    }));
    throw new Error("Recording discovery canary invocation failed");
  }
}

app.timer("recordingDiscoveryCanary", {
  handler: recordingDiscoveryCanary,
  runOnStartup: false,
  schedule: "%CANARY_TIMER_SCHEDULE%",
  useMonitor: true,
});
