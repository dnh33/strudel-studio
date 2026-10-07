// Sound library: sample maps (bundled JSON, audio streamed from GitHub), synths, soundfonts.

export interface LibItem {
  id: string;
  label: string;
  kind: 'sample' | 'synth' | 'soundfont' | 'plugin';
  sound: string;
  bank?: string;
  n?: number;
  count?: number;
  rootNote?: number;
}

export interface LibFolder {
  id: string;
  label: string;
  items: LibItem[];
  folders?: LibFolder[];
}

const DRUM_NAMES: Record<string, string> = {
  bd: 'Kick', sd: 'Snare', hh: 'Closed Hat', oh: 'Open Hat', cp: 'Clap', rim: 'Rimshot', lt: 'Low Tom',
  mt: 'Mid Tom', ht: 'High Tom', cr: 'Crash', rd: 'Ride', cb: 'Cowbell', perc: 'Perc', sh: 'Shaker',
  tb: 'Tambourine', fx: 'FX', misc: 'Misc',
};

export const SAMPLE_MAPS = [
  { file: 'tidal-drum-machines.json', label: 'Drum Machines', drums: true },
  { file: 'dirt-samples.json', label: 'Dirt Samples' },
  { file: 'vcsl.json', label: 'VCSL Instruments' },
  { file: 'piano.json', label: 'Piano' },
  { file: 'mridangam.json', label: 'Mridangam' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SampleMap = Record<string, any>;

export function buildDrumMachines(map: SampleMap): LibFolder {
  const machines = new Map<string, LibItem[]>();
  for (const key of Object.keys(map)) {
    if (key.startsWith('_')) continue;
    const i = key.indexOf('_');
    if (i < 0) continue;
    const bank = key.slice(0, i);
    const sound = key.slice(i + 1);
    const count = Array.isArray(map[key]) ? map[key].length : 1;
    if (!machines.has(bank)) machines.set(bank, []);
    machines.get(bank)!.push({
      id: `dm:${key}`,
      label: `${DRUM_NAMES[sound] ?? sound} (${sound})`,
      kind: 'sample',
      sound,
      bank,
      count,
    });
  }
  const order = ['bd', 'sd', 'cp', 'rim', 'hh', 'oh', 'cr', 'rd', 'lt', 'mt', 'ht', 'cb', 'sh', 'tb', 'perc', 'fx', 'misc'];
  const folders = [...machines.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bank, items]) => ({
      id: `dm:${bank}`,
      label: bank,
      items: items.sort((a, b) => order.indexOf(a.sound) - order.indexOf(b.sound)),
    }));
  return { id: 'drum-machines', label: 'Drum Machines', items: [], folders };
}

export function buildFlatMap(id: string, label: string, map: SampleMap): LibFolder {
  const items: LibItem[] = [];
  for (const key of Object.keys(map).sort()) {
    if (key.startsWith('_')) continue;
    const v = map[key];
    const pitched = !Array.isArray(v) && typeof v === 'object';
    items.push({
      id: `${id}:${key}`,
      label: key,
      kind: 'sample',
      sound: key,
      count: Array.isArray(v) ? v.length : 1,
      rootNote: pitched ? 60 : 36,
    });
  }
  return { id, label, items };
}

export const SYNTHS: LibItem[] = [
  { id: 'syn:sawtooth', label: 'Sawtooth', kind: 'synth', sound: 'sawtooth' },
  { id: 'syn:square', label: 'Square', kind: 'synth', sound: 'square' },
  { id: 'syn:triangle', label: 'Triangle', kind: 'synth', sound: 'triangle' },
  { id: 'syn:sine', label: 'Sine', kind: 'synth', sound: 'sine' },
  { id: 'syn:supersaw', label: 'Supersaw', kind: 'synth', sound: 'supersaw' },
  { id: 'syn:pulse', label: 'Pulse', kind: 'synth', sound: 'pulse' },
  { id: 'syn:sbd', label: 'Synth Kick (sbd)', kind: 'synth', sound: 'sbd', rootNote: 36 },
  { id: 'syn:white', label: 'White Noise', kind: 'synth', sound: 'white' },
  { id: 'syn:pink', label: 'Pink Noise', kind: 'synth', sound: 'pink' },
  { id: 'syn:brown', label: 'Brown Noise', kind: 'synth', sound: 'brown' },
  { id: 'syn:crackle', label: 'Crackle', kind: 'synth', sound: 'crackle' },
  { id: 'syn:z_sawtooth', label: 'ZZFX Saw', kind: 'synth', sound: 'z_sawtooth' },
  { id: 'syn:z_square', label: 'ZZFX Square', kind: 'synth', sound: 'z_square' },
  { id: 'syn:z_triangle', label: 'ZZFX Triangle', kind: 'synth', sound: 'z_triangle' },
  { id: 'syn:z_sine', label: 'ZZFX Sine', kind: 'synth', sound: 'z_sine' },
  { id: 'syn:z_noise', label: 'ZZFX Noise', kind: 'synth', sound: 'z_noise' },
];

export const GM_SOUNDFONTS = `gm_piano gm_epiano1 gm_epiano2 gm_harpsichord gm_clavinet gm_celesta gm_glockenspiel gm_music_box gm_vibraphone gm_marimba gm_xylophone gm_tubular_bells gm_dulcimer gm_drawbar_organ gm_percussive_organ gm_rock_organ gm_church_organ gm_reed_organ gm_accordion gm_harmonica gm_bandoneon gm_acoustic_guitar_nylon gm_acoustic_guitar_steel gm_electric_guitar_jazz gm_electric_guitar_clean gm_electric_guitar_muted gm_overdriven_guitar gm_distortion_guitar gm_guitar_harmonics gm_acoustic_bass gm_electric_bass_finger gm_electric_bass_pick gm_fretless_bass gm_slap_bass_1 gm_slap_bass_2 gm_synth_bass_1 gm_synth_bass_2 gm_violin gm_viola gm_cello gm_contrabass gm_tremolo_strings gm_pizzicato_strings gm_orchestral_harp gm_timpani gm_string_ensemble_1 gm_string_ensemble_2 gm_synth_strings_1 gm_synth_strings_2 gm_choir_aahs gm_voice_oohs gm_synth_choir gm_orchestra_hit gm_trumpet gm_trombone gm_tuba gm_muted_trumpet gm_french_horn gm_brass_section gm_synth_brass_1 gm_synth_brass_2 gm_soprano_sax gm_alto_sax gm_tenor_sax gm_baritone_sax gm_oboe gm_english_horn gm_bassoon gm_clarinet gm_piccolo gm_flute gm_recorder gm_pan_flute gm_blown_bottle gm_shakuhachi gm_whistle gm_ocarina gm_lead_1_square gm_lead_2_sawtooth gm_lead_3_calliope gm_lead_4_chiff gm_lead_5_charang gm_lead_6_voice gm_lead_7_fifths gm_lead_8_bass_lead gm_pad_new_age gm_pad_warm gm_pad_poly gm_pad_choir gm_pad_bowed gm_pad_metallic gm_pad_halo gm_pad_sweep gm_fx_rain gm_fx_soundtrack gm_fx_crystal gm_fx_atmosphere gm_fx_brightness gm_fx_goblins gm_fx_echoes gm_fx_sci_fi gm_sitar gm_banjo gm_shamisen gm_koto gm_kalimba gm_bagpipe gm_fiddle gm_shanai gm_tinkle_bell gm_agogo gm_steel_drums gm_woodblock gm_taiko_drum gm_melodic_tom gm_synth_drum gm_reverse_cymbal gm_guitar_fret_noise gm_breath_noise gm_seashore gm_bird_tweet gm_telephone gm_helicopter gm_applause gm_gunshot`
  .split(' ')
  .map((s) => ({
    id: `sf:${s}`,
    label: s.replace(/^gm_/, '').replace(/_/g, ' '),
    kind: 'soundfont' as const,
    sound: s,
  }));

export function prettySoundName(sound: string) {
  return DRUM_NAMES[sound] ?? sound.replace(/^gm_/, '').replace(/_/g, ' ');
}
