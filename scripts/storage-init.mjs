// Creates the video bucket and its CORS rules. Works against local RustFS and Cloudflare R2.
// Usage: node --env-file=.env.local scripts/storage-init.mjs
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const Bucket = process.env.S3_BUCKET;

try {
  await s3.send(new HeadBucketCommand({ Bucket }));
  console.log(`bucket ${Bucket} exists`);
} catch {
  await s3.send(new CreateBucketCommand({ Bucket }));
  console.log(`created bucket ${Bucket}`);
}

const origins = (process.env.APP_ORIGIN ?? "http://localhost:3000").split(",");
try {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ["GET", "HEAD", "PUT"],
            AllowedHeaders: ["Content-Type", "Range"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  const cors = await s3.send(new GetBucketCorsCommand({ Bucket }));
  console.log("CORS rules:", JSON.stringify(cors.CORSRules));
} catch (e) {
  console.warn("Could not set bucket CORS (the server may apply a global CORS policy instead):", e.name, e.message);
}
