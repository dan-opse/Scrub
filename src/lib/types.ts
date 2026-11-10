import type { Rate } from "./timecode";

export type Project = { id: string; name: string; default_start_tc: string; created_at: string };
export type Asset = { id: string; project_id: string; name: string; created_at: string };

export type Version = {
  id: string;
  asset_id: string;
  number: number;
  status: "uploading" | "ready" | "failed";
  original_filename: string;
  original_bytes: number;
  container: string | null;
  mime_type: string | null;
  video_codec_string: string | null;
  is_hdr: boolean;
  width: number | null;
  height: number | null;
  rotation: number;
  fps_num: number;
  fps_den: number;
  frame_count: number;
  first_pts: number;
  start_tc_frames: number;
  drop_frame: boolean;
  is_vfr: boolean;
  audio_codec: string | null;
  created_at: string;
};

export type CommentKind = "note" | "cut";
export type CommentStatus = "open" | "accepted" | "rejected" | "done" | "withdrawn";

export type Comment = {
  id: string;
  version_id: string;
  parent_id: string | null;
  kind: CommentKind;
  start_frame: number | null;
  end_frame: number | null;
  body: string;
  status: CommentStatus;
  author_id: string;
  author_name: string;
  author_role: "editor" | "guest";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** client-only: not yet confirmed by the server */
  pending?: boolean;
};

export type ShareLink = {
  id: string;
  asset_id: string;
  token: string;
  label: string | null;
  allow_comments: boolean;
  allow_download: boolean;
  revoked_at: string | null;
  created_at: string;
};

export type Access = { role: "editor" | "guest"; display_name: string; allow_comments: boolean; allow_download: boolean };

export const versionRate = (v: Pick<Version, "fps_num" | "fps_den">): Rate => ({ num: v.fps_num, den: v.fps_den });
