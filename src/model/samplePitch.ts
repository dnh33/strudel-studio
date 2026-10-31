import type { Channel } from './types';

/**
 * Semitones between a sample map's note labels and what the recordings really sound like.
 * Several VCSL instruments sound one octave above their labels: `note("c4")` on them plays a C5.
 * Measured by FFT (fundamental with a subharmonic check) on two labelled samples per instrument.
 * The studio subtracts the offset from piano-roll notes, so the roll shows the pitch you hear.
 * Exported code carries the shifted notes, so it sounds the same on strudel.cc, which uses the same map.
 */
export const SAMPLE_LABEL_OFFSET: Record<string, number> = {
  // VCSL, one octave above the label (2-5 samples each agreed within 30 cents)
  ...Object.fromEntries(
    [
      'recorder_alto_stacc', 'recorder_alto_vib', 'recorder_alto_sus', 'recorder_bass_stacc', 'recorder_bass_vib', 'recorder_bass_sus',
      'recorder_soprano_stacc', 'recorder_soprano_sus', 'recorder_tenor_stacc', 'recorder_tenor_vib', 'recorder_tenor_sus',
      'ocarina_small_stacc', 'ocarina_small', 'ocarina', 'ocarina_vib', 'pipeorgan_quiet_pedal', 'pipeorgan_quiet',
      'organ_8inch', 'organ_full', 'harmonica', 'harmonica_soft', 'harmonica_vib', 'super64', 'super64_acc', 'super64_vib',
      'saxello', 'saxello_stacc', 'saxello_vib', 'sax', 'sax_stacc', 'sax_vib', 'folkharp', 'strumstick', 'dantranh',
      'dantranh_tremolo', 'dantranh_vibrato', 'kawai', 'psaltery_pluck', 'psaltery_spiccato', 'psaltery_bow', 'piano1',
      'wineglass', 'wineglass_slow', 'balafon_hard', 'balafon_soft', 'balafon', 'belltree', 'glockenspiel', 'handchimes',
      'kalimba', 'kalimba3', 'kalimba4', 'kalimba5', 'marimba', 'tubularbells2', 'vibraphone', 'vibraphone_soft',
      'vibraphone_bowed', 'xylophone_hard_pp', 'xylophone_hard_ff', 'xylophone_medium_ff', 'xylophone_medium_pp',
      'xylophone_soft_pp', 'xylophone_soft_ff',
    ].map((s) => [s, 12]),
  ),
  // two octaves above the label
  organ_4inch: 24,
  clavisynth: 24,
  // labelled correctly, so absent: harp, steinway, fmpiano, pipeorgan_loud_pedal, and the Salamander `piano`.
  // Left alone because no single offset fits: pipeorgan_loud (+12 low, 0 high), kalimba2 (up to 50 cents out of
  // tune), tubularbells (inharmonic, no clear fundamental).
};

/** label offset for a channel's sound (0 for everything that is labelled correctly) */
export function labelOffset(ch: Pick<Channel, 'kind' | 'sound' | 'bank'>): number {
  if (ch.kind !== 'sample' || ch.bank) return 0;
  return SAMPLE_LABEL_OFFSET[ch.sound] ?? 0;
}

/** semitones to add to piano-roll notes before they go to Strudel */
export function noteShift(ch: Pick<Channel, 'kind' | 'sound' | 'bank' | 'params'>): number {
  return Math.round(ch.params.transpose ?? 0) - labelOffset(ch);
}

/**
 * Strudel note for step-triggered samples, or null for none. Plain sample arrays treat note 36 as
 * "unchanged", so 36 + transpose repitches the step and multiplies with any `.speed()` on the channel.
 */
export function stepNote(ch: Pick<Channel, 'kind' | 'params'>): number | null {
  if (ch.kind !== 'sample') return null;
  const t = Math.round(ch.params.transpose ?? 0);
  return t ? 36 + t : null;
}
