// Initials and a stable colour per person, for comment avatars and timeline markers.

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const s = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return s.toUpperCase();
}

// Muted hues that read on the dark panels with white text.
const HUES = [262, 200, 160, 24, 330, 45, 290, 120];

export function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${HUES[Math.abs(h) % HUES.length]} 55% 58%)`;
}

/** "now", "5m", "3h", "5d", "2w", then a short date. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 5 * 7 * 86400) return `${Math.floor(s / (7 * 86400))}w`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
