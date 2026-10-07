// Standard MIDI File (type 1) export of the song (or one pattern).
import type { Project } from './types';
import { PPQ, TICKS_PER_STEP, ticksPerBar } from './types';
import { getSteps } from './factory';
import { songLengthBars } from './compile';

interface Ev {
  tick: number;
  on: boolean;
  key: number;
  vel: number;
}

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function track(events: number[][]): number[] {
  const body = events.flat();
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body];
}

function textEvent(type: number, text: string) {
  const b = [...new TextEncoder().encode(text)];
  return [0, 0xff, type, ...vlq(b.length), ...b];
}

export function projectToMidi(project: Project, patternId: string | null): Uint8Array<ArrayBuffer> {
  const tpb = ticksPerBar(project);
  const perChannel = new Map<string, Ev[]>();
  const add = (chId: string, start: number, len: number, key: number, vel: number) => {
    const list = perChannel.get(chId) ?? [];
    const v = Math.max(1, Math.min(127, Math.round(vel * 127)));
    list.push({ tick: Math.round(start), on: true, key, vel: v }, { tick: Math.round(start + Math.max(1, len)), on: false, key, vel: 0 });
    perChannel.set(chId, list);
  };

  const placements: { patternId: string; start: number; length: number }[] = patternId
    ? [{ patternId, start: 0, length: project.patterns.find((p) => p.id === patternId)?.bars ?? 1 }]
    : project.clips
        .filter((c) => c.kind === 'pattern' && c.patternId && !project.tracks[c.track]?.mute)
        .map((c) => ({ patternId: c.patternId!, start: c.start, length: Math.min(c.length, songLengthBars(project) - c.start) }));

  for (const pl of placements) {
    const pt = project.patterns.find((p) => p.id === pl.patternId);
    if (!pt) continue;
    const clipStart = pl.start * tpb;
    const clipEnd = (pl.start + pl.length) * tpb;
    const period = pt.bars * tpb;
    for (const ch of project.channels) {
      if (ch.kind === 'code' || ch.mute) continue;
      const transpose = Math.round(ch.params.transpose ?? 0);
      const notes = pt.notes[ch.id] ?? [];
      for (let rep = 0; clipStart + rep * period < clipEnd; rep++) {
        const base = clipStart + rep * period;
        if (notes.length) {
          for (const n of notes) {
            const s = base + n.start;
            if (s >= clipEnd) continue;
            add(ch.id, s, Math.min(n.len, clipEnd - s), n.key + transpose, n.vel);
          }
        } else {
          getSteps(project, pt, ch.id).forEach((v, i) => {
            const s = base + i * TICKS_PER_STEP;
            if (v > 0 && s < clipEnd) add(ch.id, s, TICKS_PER_STEP, ch.rootNote + transpose, v);
          });
        }
      }
    }
  }

  const tempo = Math.round(60000000 / project.bpm);
  const conductor = track([
    textEvent(0x03, project.name),
    [0, 0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255],
    [0, 0xff, 0x58, 0x04, project.beatsPerBar, 2, 24, 8],
    [0, 0xff, 0x2f, 0x00],
  ]);
  const tracks: number[][] = [conductor];
  let midiCh = 0;
  for (const ch of project.channels) {
    const evs = perChannel.get(ch.id);
    if (!evs?.length) continue;
    const isDrum = ch.kind === 'sample' && !!ch.bank;
    let c = 9;
    if (!isDrum) {
      if (midiCh % 16 === 9) midiCh++; // channel 10 is reserved for drums
      c = midiCh % 16;
      midiCh++;
    }
    evs.sort((a, b) => a.tick - b.tick || (a.on === b.on ? 0 : a.on ? 1 : -1));
    const out: number[][] = [textEvent(0x03, ch.name)];
    let last = 0;
    for (const e of evs) {
      out.push([...vlq(e.tick - last), (e.on ? 0x90 : 0x80) | c, Math.max(0, Math.min(127, e.key)), e.vel]);
      last = e.tick;
    }
    out.push([0, 0xff, 0x2f, 0x00]);
    tracks.push(track(out));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}
