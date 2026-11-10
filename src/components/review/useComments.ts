"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, errorMessage } from "@/lib/client/supabase";
import type { Comment, CommentKind } from "@/lib/types";

/**
 * Comments for one version, kept live with Supabase Realtime.
 * The database is the source of truth: after any reconnect or tab return we refetch.
 */
export function useComments(versionId: string | null) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(versionId);
  useEffect(() => {
    latest.current = versionId;
  });

  const upsert = useCallback((rows: Comment[]) => {
    setComments((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      for (const r of rows) {
        if (r.version_id !== latest.current) continue;
        map.set(r.id, { ...r, pending: false });
      }
      return [...map.values()];
    });
  }, []);

  const refetch = useCallback(async () => {
    if (!versionId) return;
    const { data, error } = await supabase().from("comments").select("*").eq("version_id", versionId);
    if (error) return setError(error.message);
    if (latest.current !== versionId) return;
    setComments((prev) => {
      const pending = prev.filter((c) => c.pending && c.version_id === versionId);
      const fresh = new Map((data as Comment[]).map((c) => [c.id, c]));
      for (const p of pending) if (!fresh.has(p.id)) fresh.set(p.id, p);
      return [...fresh.values()];
    });
  }, [versionId]);

  // The review screen is keyed by version, so this hook never switches versions in place.
  useEffect(() => {
    if (!versionId) return;
    const sb = supabase();
    const channel = sb
      .channel(`comments:${versionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "comments", filter: `version_id=eq.${versionId}` },
        (payload) => {
          if (payload.new && "id" in payload.new) upsert([payload.new as Comment]);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") refetch();
      });
    const onVisible = () => document.visibilityState === "visible" && refetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refetch);
    return () => {
      sb.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refetch);
    };
  }, [versionId, refetch, upsert]);

  /** Optimistic insert with a client-generated id, so retries never duplicate. */
  const add = useCallback(
    async (c: { kind: CommentKind; start_frame: number | null; end_frame: number | null; body: string; parent_id?: string | null }, me: { id: string; name: string; role: "editor" | "guest" }) => {
      if (!versionId) return;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const optimistic: Comment = {
        id,
        version_id: versionId,
        parent_id: c.parent_id ?? null,
        kind: c.kind,
        start_frame: c.start_frame,
        end_frame: c.end_frame,
        body: c.body,
        status: "open",
        author_id: me.id,
        author_name: me.name,
        author_role: me.role,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        done_in_version_id: null,
        pending: true,
      };
      setComments((p) => [...p, optimistic]);
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, error } = await supabase()
          .from("comments")
          .upsert({ id, version_id: versionId, parent_id: c.parent_id ?? null, kind: c.kind, start_frame: c.start_frame, end_frame: c.end_frame, body: c.body }, { onConflict: "id", ignoreDuplicates: true })
          .select("*");
        if (!error) {
          if (data?.[0]) upsert(data as Comment[]);
          else refetch();
          return;
        }
        const transient = !error.code || error.code === "PGRST000" || /fetch|network/i.test(error.message);
        if (!transient) {
          setComments((p) => p.filter((x) => x.id !== id));
          throw new Error(errorMessage(error));
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
      throw new Error("Couldn't send. It will stay here marked as not sent.");
    },
    [versionId, upsert, refetch],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Pick<Comment, "body" | "start_frame" | "end_frame" | "status" | "deleted_at">>) => {
      const { data, error } = await supabase().from("comments").update(patch).eq("id", id).select("*");
      if (error) throw new Error(errorMessage(error));
      if (data?.[0]) upsert(data as Comment[]);
    },
    [upsert],
  );

  const setStatus = useCallback(
    async (id: string, status: Comment["status"], reply?: string) => {
      const { error } = await supabase().rpc("set_comment_status", { p_comment: id, p_status: status, p_reply: reply ?? null });
      if (error) throw new Error(errorMessage(error));
      await refetch();
    },
    [refetch],
  );

  return { comments, error, add, update, setStatus, refetch };
}
