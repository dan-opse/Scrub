import { CompleteMultipartUploadCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, s3 } from "@/lib/server/storage";

// Finishes the upload, checks the stored size matches the file, and marks the version ready.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, parts } = (await req.json()) as {
    versionId: string;
    parts: { partNumber: number; etag: string }[];
  };
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor" || !version.upload_id) throw new HttpError(403, "No active upload");
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: version.original_key,
      UploadId: version.upload_id,
      MultipartUpload: {
        Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: version.original_key }));
  if (Number(head.ContentLength) !== Number(version.original_bytes)) {
    await db.from("versions").update({ status: "failed" }).eq("id", version.id);
    throw new HttpError(422, "The stored file size doesn't match. Please upload again.");
  }
  const { error } = await db.from("versions").update({ status: "ready", upload_id: null }).eq("id", version.id);
  if (error) throw new HttpError(500, error.message);
  return { ok: true };
});
