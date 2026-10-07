export const SCALES: Record<string, number[]> = {
  None: [],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'Harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'Pentatonic major': [0, 2, 4, 7, 9],
  'Pentatonic minor': [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10],
};

export const CHORDS: Record<string, number[]> = {
  Off: [0],
  Major: [0, 4, 7],
  Minor: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  Power: [0, 7, 12],
  Octave: [0, 12],
};

export const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function inScale(key: number, root: number, scale: number[]) {
  if (!scale.length) return true;
  return scale.includes((((key - root) % 12) + 12) % 12);
}

export const SNAPS: { label: string; ticks: number }[] = [
  { label: 'Bar', ticks: -1 },
  { label: 'Beat', ticks: 96 },
  { label: '1/2 beat', ticks: 48 },
  { label: '1/3 beat', ticks: 32 },
  { label: 'Step (1/16)', ticks: 24 },
  { label: '1/6 beat', ticks: 16 },
  { label: '1/32', ticks: 12 },
  { label: 'None', ticks: 1 },
];
