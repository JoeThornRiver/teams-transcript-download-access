import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const WATERMARK_CONTAINER = "state";
const WATERMARK_BLOB = "last-successful-run.json";

export function createManagedIdentityTokenProvider(clientId) {
  const credential = new ManagedIdentityCredential(clientId);
  return {
    credential,
    async getGraphAccessToken() {
      const result = await credential.getToken(GRAPH_SCOPE);
      if (!result?.token) throw new Error("Managed identity did not return a Graph access token");
      return result.token;
    },
  };
}

export function createAzureBlobWatermarkStore({ accountUrl, credential }) {
  const blobClient = new BlobServiceClient(accountUrl, credential)
    .getContainerClient(WATERMARK_CONTAINER)
    .getBlockBlobClient(WATERMARK_BLOB);
  return createBlobWatermarkStore(blobClient);
}

export function createBlobWatermarkStore(blobClient) {
  return {
    async read() {
      try {
        const response = await blobClient.download();
        const content = await streamToString(response.readableStreamBody);
        return JSON.parse(content);
      } catch (error) {
        if (error?.statusCode === 404) return undefined;
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }
    },
    async write(value) {
      const content = JSON.stringify(value);
      await blobClient.upload(content, Buffer.byteLength(content), {
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
    },
  };
}

async function streamToString(stream) {
  if (!stream) throw new Error("Watermark download returned no content stream");
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
