"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Range } from "@/lib/ranges";
import { type Rate, currentTimeToFrame, frameToSeekTime, mediaTimeToFrame } from "@/lib/timecode";

/** A tiny external store so only the playhead and clock re-render on every frame. */
export function createFrameStore() {
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set(f: number) {
      if (f === frame) return;
      frame = f;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
export type FrameStore = ReturnType<typeof createFrameStore>;

export const useFrame = (store: FrameStore) => useSyncExternalStore(store.subscribe, store.get, store.get);

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export type DecodeState = "idle" | "loading" | "ok" | "unsupported";

type Options = {
  rate: Rate;
  firstPts: number;
  frameCount: number;
  url: string | null;
  /** Called when the signed URL has expired or the network dropped mid-playback. */
  onNetworkError: () => void;
};

export function usePlayer({ rate, firstPts, frameCount, url, onNetworkError }: Options) {
  const [store] = useState(createFrameStore);
  const videoRef = useRef<VideoWithRvfc | null>(null);
  // Holds a captured frame on screen when the decoder can't display it while paused.
  const freezeRef = useRef<HTMLCanvasElement | null>(null);
  const frozen = useRef(false);
  const [frozenVisible, setFrozenVisible] = useState(false);
  const unfreeze = useCallback(() => {
    if (!frozen.current) return;
    frozen.current = false;
    setFrozenVisible(false);
  }, []);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [decode, setDecode] = useState<DecodeState>("idle");

  const skip = useRef<Range[] | null>(null); // preview-without-cuts ranges
  const windowRef = useRef<{ to: number; skip?: Range } | null>(null); // play-in-context window
  const seekTarget = useRef<number | null>(null); // latest requested frame while a seek is in flight
  // Seek confirmation. Some files (open-GOP H.265) can't show the frames just before a keyframe
  // by seeking at all; for those we back off to an earlier frame and crawl forward slowly.
  const confirm = useRef<{
    target: number;
    tries: number;
    phase: "seek" | "backoff" | "crawl";
    back: number;
    saved?: { rate: number; muted: boolean };
  } | null>(null);
  const jumping = useRef(false);
  const seq = useRef({ frames: 0, atSeek: 0 }); // frames presented, and the count when the last seek started
  const restore = useRef<{ frame: number; play: boolean } | null>(null);
  const cfg = useRef({ rate, firstPts, frameCount, onNetworkError });
  useEffect(() => {
    cfg.current = { rate, firstPts, frameCount, onNetworkError };
  });

  const clamp = (f: number) => Math.max(0, Math.min(cfg.current.frameCount - 1, Math.round(f)));

  const rawSeek = useCallback((frame: number) => {
    const v = videoRef.current;
    if (!v) return;
    const f = clamp(frame);
    if (v.seeking) {
      seekTarget.current = f; // newest target wins once the current seek lands
      return;
    }
    seekTarget.current = null;
    if (!confirm.current || confirm.current.phase === "seek") unfreeze();
    seq.current.atSeek = seq.current.frames;
    v.currentTime = frameToSeekTime(f, cfg.current.rate, cfg.current.firstPts);
    if (v.paused) confirm.current = { target: f, tries: 0, phase: "seek", back: 0 };
  }, [unfreeze]);

  /** Confirms the frame on screen after a seek; returns true while a slow crawl is in progress. */
  const runConfirm = useCallback((f: number): boolean => {
    const v = videoRef.current!;
    const c = confirm.current;
    const seekTime = (frame: number) => {
      seq.current.atSeek = seq.current.frames;
      v.currentTime = frameToSeekTime(frame, cfg.current.rate, cfg.current.firstPts);
    };
    if (c && c.phase === "crawl") {
      if (f >= c.target) {
        if (f === c.target && freezeRef.current) {
          // Pausing makes Chrome re-seek, which can't show this frame; keep a copy on screen instead.
          const cv = freezeRef.current;
          cv.width = v.videoWidth;
          cv.height = v.videoHeight;
          cv.getContext("2d")?.drawImage(v, 0, 0);
          frozen.current = true;
          setFrozenVisible(true);
          store.set(f);
        }
        v.pause();
        v.playbackRate = c.saved!.rate;
        v.muted = c.saved!.muted;
        confirm.current = null;
      }
      return true;
    }
    if (c && v.paused && !v.seeking) {
      if (f === c.target) confirm.current = null;
      else if (c.phase === "seek" && f < c.target && c.tries < 2) {
        c.tries++;
        seekTime(c.target);
      } else if (f > c.target || c.phase === "backoff") {
        if (c.phase === "backoff" && f < c.target) {
          // Decodable frame found before the target: play forward to it at quarter speed.
          c.phase = "crawl";
          c.saved = { rate: v.playbackRate, muted: v.muted };
          v.muted = true;
          v.playbackRate = 0.25;
          v.play().catch(() => (confirm.current = null));
        } else if (c.target - c.back <= 0 || c.back >= 128) {
          confirm.current = null; // give up; the nearest showable frame stays on screen
        } else {
          c.phase = "backoff";
          c.back = c.back ? c.back * 2 : 4;
          seekTime(Math.max(0, c.target - c.back));
        }
      } else confirm.current = null;
    }
    return false;
  }, [store]);

  /** Called for every presented frame. Handles skips, windows and seek confirmation. */
  const onFrame = useCallback(
    (f: number) => {
      const v = videoRef.current!;
      if (frozen.current && v.paused) return; // the captured frame is what's on screen
      seq.current.frames++;
      store.set(f);
      if (runConfirm(f)) return;
      if (v.paused || v.seeking) return;
      const w = windowRef.current;
      const ranges = [...(skip.current ?? []), ...(w?.skip ? [w.skip] : [])];
      const r = ranges.find((x) => f >= x.start - 1 && f < x.end);
      if (r && !jumping.current) {
        if (r.end >= cfg.current.frameCount) {
          v.pause();
          return;
        }
        jumping.current = true;
        rawSeek(r.end);
      }
      if (w && f >= w.to) {
        windowRef.current = null;
        v.pause();
      }
    },
    [rawSeek, store, runConfirm],
  );

  // Frame tracking loop.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;
    let handle = 0;
    let alive = true;
    const useRvfc = typeof v.requestVideoFrameCallback === "function";
    const tick = (_: number, meta: { mediaTime: number }) => {
      if (!alive) return;
      if (v.videoWidth > 0) setDecode("ok");
      onFrame(Math.min(cfg.current.frameCount - 1, mediaTimeToFrame(meta.mediaTime, cfg.current.rate, cfg.current.firstPts)));
      handle = v.requestVideoFrameCallback!(tick);
    };
    const fallback = () => onFrame(clamp(currentTimeToFrame(v.currentTime, cfg.current.rate, cfg.current.firstPts)));
    if (useRvfc) handle = v.requestVideoFrameCallback!(tick);
    else {
      v.addEventListener("timeupdate", fallback);
      v.addEventListener("seeked", fallback);
    }
    return () => {
      alive = false;
      if (useRvfc) v.cancelVideoFrameCallback?.(handle);
      v.removeEventListener("timeupdate", fallback);
      v.removeEventListener("seeked", fallback);
    };
  }, [url, onFrame]);

  // Element events: play state, seeks, errors, source swaps.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;
    setDecode((d) => (d === "ok" ? d : "loading"));
    const onPlay = () => {
      setPlaying(true);
      if (confirm.current?.phase !== "crawl") unfreeze();
    };
    const onPause = () => {
      setPlaying(false);
      windowRef.current = null;
    };
    const onSeeked = () => {
      jumping.current = false;
      // Chrome may present the new frame before 'seeked'; confirm once the seek has settled.
      // Only trust the frame number if a frame was presented after this seek began.
      if (v.paused && seekTarget.current === null && seq.current.frames > seq.current.atSeek) runConfirm(store.get());
      if (seekTarget.current !== null) rawSeek(seekTarget.current);
    };
    const onLoaded = () => {
      const r = restore.current;
      restore.current = null;
      rawSeek(r ? r.frame : store.get());
      if (r?.play) v.play().catch(() => undefined);
      if (typeof v.requestVideoFrameCallback !== "function" && v.videoWidth > 0) setDecode("ok");
    };
    const onError = () => {
      const code = v.error?.code;
      if (code === MediaError.MEDIA_ERR_NETWORK) {
        restore.current = { frame: store.get(), play: !v.paused };
        cfg.current.onNetworkError();
      } else if (code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        setDecode("unsupported");
      }
    };
    // A file the browser "plays" without ever presenting a frame is treated as unsupported.
    const timer = window.setTimeout(() => {
      if (v.videoWidth === 0 && v.readyState < 2) setDecode((d) => (d === "ok" ? d : "unsupported"));
    }, 12000);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadeddata", onLoaded);
    v.addEventListener("error", onError);
    return () => {
      window.clearTimeout(timer);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("error", onError);
    };
  }, [url, rawSeek, store, runConfirm, unfreeze]);

  /** Swap to a fresh signed URL, keeping the frame and play state. */
  const prepareSourceSwap = useCallback(() => {
    const v = videoRef.current;
    if (v && v.currentSrc) restore.current = { frame: store.get(), play: !v.paused };
  }, [store]);

  const api = useMemo(
    () => ({
      play: () => videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      toggle: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) {
          if (store.get() >= cfg.current.frameCount - 1) rawSeek(0);
          v.play().catch(() => undefined);
        } else v.pause();
      },
      seek: (frame: number) => {
        windowRef.current = null;
        store.set(clamp(frame));
        rawSeek(frame);
      },
      step: (delta: number) => {
        const v = videoRef.current;
        v?.pause();
        const f = clamp(store.get() + delta);
        store.set(f);
        rawSeek(f);
      },
      setRate: (r: number) => {
        if (videoRef.current) videoRef.current.playbackRate = r;
        setPlaybackRateState(r);
      },
      setMuted: (m: boolean) => {
        if (videoRef.current) videoRef.current.muted = m;
        setMuted(m);
      },
      setSkipRanges: (u: Range[] | null) => {
        skip.current = u && u.length ? u : null;
      },
      /** Play from `from` to `to`, optionally jumping over `skip` (Play in context / Play as cut). */
      playWindow: (from: number, to: number, skipRange?: Range) => {
        const v = videoRef.current;
        if (!v) return;
        windowRef.current = { to: clamp(to), skip: skipRange };
        store.set(clamp(from));
        rawSeek(from);
        v.play().catch(() => undefined);
      },
      element: () => videoRef.current,
    }),
    [rawSeek, store],
  );

  const player = useMemo(
    () => ({ store, playing, playbackRate, muted, decode, prepareSourceSwap, ...api }),
    [store, playing, playbackRate, muted, decode, prepareSourceSwap, api],
  );
  return { videoRef, freezeRef, frozenVisible, player };
}

export type Player = ReturnType<typeof usePlayer>["player"];
