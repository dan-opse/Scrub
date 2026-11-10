"use client";
// Reads the start timecode from a QuickTime/MP4 timecode ('tmcd') track, which Resolve, Premiere and
// FFmpeg write into MOV exports. Only the box headers and one 4-byte sample are read.

export type TimecodeTrack = { timecode: string; dropFrame: boolean; fps: number };

type Box = { type: string; start: number; size: number; headerLen: number };

async function readBoxes(file: File, start: number, end: number): Promise<Box[]> {
  const boxes: Box[] = [];
  let pos = start;
  for (let guard = 0; guard < 512 && pos + 8 <= end; guard++) {
    const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerLen = 8;
    if (size === 1) {
      size = Number(head.getBigUint64(8));
      headerLen = 16;
    } else if (size === 0) size = end - pos;
    if (size < headerLen) break;
    boxes.push({ type, start: pos, size, headerLen });
    pos += size;
  }
  return boxes;
}

const child = async (file: File, b: Box, type: string, extraHeader = 0) =>
  (await readBoxes(file, b.start + b.headerLen + extraHeader, b.start + b.size)).find((x) => x.type === type);

const pad = (n: number) => String(n).padStart(2, "0");

export async function readTimecodeTrack(file: File): Promise<TimecodeTrack | null> {
  try {
    const top = await readBoxes(file, 0, file.size);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) return null;
    const traks = (await readBoxes(file, moov.start + moov.headerLen, moov.start + moov.size)).filter((b) => b.type === "trak");
    for (const trak of traks) {
      const mdia = await child(file, trak, "mdia");
      if (!mdia) continue;
      const minf = await child(file, mdia, "minf");
      const stbl = minf && (await child(file, minf, "stbl"));
      if (!stbl) continue;
      const stsd = await child(file, stbl, "stsd");
      if (!stsd) continue;
      // stsd: version/flags (4) + entry count (4), then sample entries
      const entry = (await readBoxes(file, stsd.start + stsd.headerLen + 8, stsd.start + stsd.size))[0];
      if (!entry || entry.type !== "tmcd") continue;
      // tmcd sample entry: 6 reserved + 2 data ref index, 4 reserved, flags u32, timescale u32, frameDuration u32, numberOfFrames u8
      const e = new DataView(await file.slice(entry.start + entry.headerLen, entry.start + entry.headerLen + 26).arrayBuffer());
      const flags = e.getUint32(12);
      const timescale = e.getUint32(16);
      const frameDuration = e.getUint32(20);
      const numberOfFrames = e.getUint8(24);
      const dropFrame = (flags & 0x0001) !== 0;
      const fps = frameDuration > 0 ? timescale / frameDuration : numberOfFrames;
      // first chunk offset -> first sample: a big-endian u32 frame count
      const stco = (await child(file, stbl, "stco")) ?? (await child(file, stbl, "co64"));
      if (!stco) continue;
      const c = new DataView(await file.slice(stco.start + stco.headerLen, stco.start + stco.headerLen + 16).arrayBuffer());
      const offset = stco.type === "co64" ? Number(c.getBigUint64(8)) : c.getUint32(8);
      const sample = new DataView(await file.slice(offset, offset + 4).arrayBuffer()).getUint32(0);
      // The sample counts frames (drop-frame files count labels, i.e. the frame number already skips dropped labels)
      const nominal = numberOfFrames || Math.round(fps);
      let n = sample;
      if (dropFrame) {
        // convert the frame count to a drop-frame label
        const drop = nominal === 30 ? 2 : 4;
        const per10Min = nominal * 600 - drop * 9;
        const perMin = nominal * 60 - drop;
        const tens = Math.floor(n / per10Min);
        const rem = n % per10Min;
        n += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
      }
      const ff = n % nominal;
      const ss = Math.floor(n / nominal) % 60;
      const mm = Math.floor(n / (nominal * 60)) % 60;
      const hh = Math.floor(n / (nominal * 3600)) % 24;
      return { timecode: `${pad(hh)}:${pad(mm)}:${pad(ss)}${dropFrame ? ";" : ":"}${pad(ff)}`, dropFrame, fps };
    }
    return null;
  } catch {
    return null;
  }
}
