import { ListPartsCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, s3 } from "@/lib/server/storage";

// Lists parts already stored, so an interrupted upload can resume.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId } = await req.json();
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor" || !version.upload_id) throw new HttpError(403, "No active upload");
  const parts: { partNumber: number; etag: string; size: number }[] = [];
  let marker: string | undefined;
  do {
    const res = await s3.send(
      new ListPartsCommand({ Bucket: BUCKET, Key: version.original_key, UploadId: version.upload_id, PartNumberMarker: marker }),
    );
    for (const p of res.Parts ?? []) parts.push({ partNumber: p.PartNumber!, etag: p.ETag!, size: p.Size ?? 0 });
    marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (marker);
  return { parts };
});
