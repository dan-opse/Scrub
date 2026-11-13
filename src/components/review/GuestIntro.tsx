"use client";
import { useState } from "react";

const KEY = "scrub:guest-intro-dismissed";

function readDismissed() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** A short "how to review" strip for clients, shown until they dismiss it (remembered per browser). */
export function GuestIntro({ editorName, canComment }: { editorName: string | null; canComment: boolean }) {
  const [hidden, setHidden] = useState(readDismissed);
  if (hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* private window: just hide for now */
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-accent/30 bg-accent/10 px-4 py-2.5 text-sm">
      <span className="font-medium">
        {editorName ? `${editorName} wants your feedback on this video` : "You're reviewing this video"}
      </span>
      {canComment ? (
        <ol className="flex flex-wrap gap-x-5 gap-y-1 text-ink-2">
          <li>
            <span className="mr-1.5 text-note">●</span>Pause anywhere and type a comment (or press <kbd className="kbd">C</kbd>)
          </li>
          <li>
            <span className="mr-1.5 text-cut">✂</span>Drag along the red lane under the video to ask for a cut
          </li>
          <li className="text-ink-3">Your editor sees everything as you go. No need to save.</li>
        </ol>
      ) : (
        <span className="text-ink-2">This link is view only.</span>
      )}
      <button className="btn btn-ghost btn-sm ml-auto" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
