import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

// Works with Cloudflare R2 in production and local RustFS in development.
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "auto",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
  // The SDK's default checksum headers break presigned URLs on R2 and local S3 servers.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export const BUCKET = process.env.S3_BUCKET!;
export const PART_SIZE = 16 * 1024 * 1024; // R2 requires equal-size parts except the last
export const PLAYBACK_TTL_SECONDS = 2 * 60 * 60;

export const originalKey = (assetId: string, versionId: string, filename: string) => {
  const ext = /\.mov$/i.test(filename) ? "mov" : "mp4";
  return `assets/${assetId}/versions/${versionId}/original.${ext}`;
};
