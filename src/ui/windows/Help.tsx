import { Window } from '../components/Window';
import { isNative } from '../../native/bridge';

const KEYS: [string, string][] = [
  ['Space', 'Play / stop'],
  ['Esc', 'Stop'],
  ['L', 'Toggle pattern / song mode (when typing keyboard is off)'],
  ['F1', 'Help'],
  ['F4', 'New pattern'],
  ['F5 / F6 / F7', 'Playlist / Channel rack / Piano roll'],
  ['F8 / F9 / F10', 'Plugin Lab / Mixer / Strudel code'],
  ['Numpad + / −', 'Next / previous pattern'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+S', 'Save project file'],
  ['Ctrl+Shift+S', isNative ? 'Save project as…' : 'Save to browser storage'],
  ['Ctrl+O / Ctrl+N', 'Open / new project'],
  ['Ctrl+R', 'Export (WAV, stems, MIDI, code)'],
  ['Z…M, Q…P', 'Typing keyboard piano (plays the selected channel), - / = octave'],
  ['Piano roll', 'Click: draw · drag: move · drag edge: resize · right-click: delete · Ctrl+drag: select · Alt: no snap'],
  ['Piano roll keys', 'Del, Ctrl+A/C/X/V/D, Ctrl+Q quantize, ↑↓ transpose (Shift = octave), ←→ move'],
  ['Playlist', 'Click: paint pattern · drag: move (Shift = copy) · edge: resize · right-click: delete · Shift+right-click: menu · Ctrl+B duplicate'],
  ['Playlist ruler', 'Click: set song position · drag: loop region · double-click: clear loop'],
  ['Channel rack', 'Click steps · drag to paint · right-drag to erase · Alt+drag: velocity · right-click channel: menu'],
  ['Knobs', 'Drag / wheel, Shift = fine, double-click = reset, right-click = automation'],
  ['Code editor', 'Ctrl+Enter run · Ctrl+. stop'],
];

export function Help() {
  return (
    <Window id="help" title="Strudel Studio — help">
      <div className="help">
        <h2>Strudel Studio</h2>
        <p>
          A pattern-based music studio (channel rack, piano roll, playlist, mixer) whose sound engine is <a href="https://strudel.cc" target="_blank" rel="noreferrer">Strudel</a>. Everything you build is
          compiled to Strudel code in real time (see the <b>Strudel code</b> window) — you can copy it to strudel.cc, keep live-coding on top of it in the <b>Live code</b> tab, or add
          hand-written <b>code channels</b> to the channel rack.
        </p>
        <h3>Workflow</h3>
        <ol>
          <li>Drag sounds from the browser (left) into the <b>Channel rack</b>. Program drums with the step sequencer.</li>
          <li>Double-click a channel for its settings (envelope, filter, pitch, FX); open the <b>Piano roll</b> (F7) for melodies & chords.</li>
          <li>Make more patterns (F4). In the <b>Playlist</b>, paint patterns onto tracks to arrange a song and switch the transport to <b>SONG</b>.</li>
          <li>Route channels to <b>Mixer</b> inserts: Strudel reverb/delay/sidechain per insert, plus native effect slots (EQ, compressor, chorus…).</li>
          <li>Right-click any knob → <b>Create automation clip</b> to automate it over the song.</li>
          <li>Export a WAV (or stems / MIDI / code) with Ctrl+R.</li>
        </ol>
        <h3>Plugins (“VSTs for Strudel”)</h3>
        <p>
          Plugin instruments are small JavaScript programs built on Strudel’s own <code>registerSound</code> API. The studio ships with 3xOsc, SuperPad, FM Keys, ChipBoy, Sub 808,
          Pluck (Karplus-Strong, AudioWorklet) and DrumSynth. Write your own in the <b>Plugin Lab</b> (F8) — plugins are saved with the project and embedded when you export code, so they
          also run on strudel.cc. Mixer effect slots are native WebAudio effects rendered into your WAV exports.
        </p>
        <h3>VST3 plug-ins — the native app</h3>
        <p>
          {isNative ? 'You are running the Strudel Studio native app (JUCE). ' : 'The Strudel Studio native app (Windows, built with JUCE) runs this same studio and adds real VST3 hosting. '}
          In the native app: <b>Audio → Scan for new VST3 plug-ins</b>, then double-click an instrument in the browser’s <b>VST3 plug-ins</b> folder (or use the channel
          rack <b>+</b> menu). Program it with steps, the piano roll, code or your MIDI keyboard like any other channel. Its settings window shows the plug-in’s own editor and an
          effect chain for VST3 effects. Audio → <b>Audio &amp; MIDI settings</b> selects ASIO / WASAPI devices and buffer size; MIDI devices are picked up automatically. VST3
          channels are played by the native audio engine (sample-accurate, timestamped by Strudel) and are included in WAV exports; plug-in states are stored in the project file.
          If VST3 channels sound early or late against the Strudel sounds, adjust Audio → <b>VST3 timing offset</b>.
        </p>
        <h3>Shortcuts</h3>
        <table>
          <tbody>
            {KEYS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Notes</h3>
        <ul>
          <li>Samples are streamed from GitHub (tidal-drum-machines, Dirt-Samples, VCSL) the first time they play — an internet connection is needed; your own imported samples stay in the browser.</li>
          <li>Your work autosaves in the browser. Use File → Save to keep a .json project file.</li>
          <li>Strudel is AGPL-3.0 licensed; so is this studio.</li>
        </ul>
      </div>
    </Window>
  );
}
