# Strudel Studio — native app (JUCE)

A desktop program that runs the Strudel Studio web UI in a WebView and adds VST3 hosting, native audio
(ASIO / WASAPI / DirectSound on Windows, CoreAudio on macOS, ALSA / JACK on Linux), native MIDI input and
file dialogs. Built with [JUCE 9](https://juce.com/features/) (AGPLv3 — the same license as Strudel and this project).

Windows users: just run **`Build Native App.bat`** in the project folder (see the main README).

## Architecture

```
┌──────────────────────── Strudel Studio.exe (JUCE) ────────────────────────┐
│  WebBrowserComponent (WebView2)                                            │
│   └─ the web studio (app/index.html, served from https://juce.backend/)    │
│        Strudel scheduler ─ superdough ─ WebAudio  ──▶ Windows audio         │
│        VST3 channel: .s("native").vst('<id>') ─┐                           │
│                                                │ ss_notes [{t,n,v,at,d}]   │
│  NativeBridge (native functions ss_*, events) ◀┘                           │
│   └─ AudioEngine (AudioDeviceManager: ASIO/WASAPI…)                        │
│        per VST3 channel: notes ─▶ instrument ─▶ effects ─▶ vol/pan ─▶ out   │
│   └─ PluginHost (VST3 scan cache, instances)  └─ PluginWindows (editors)   │
└────────────────────────────────────────────────────────────────────────────┘
```

* **Sequencing stays in Strudel.** A VST3 channel compiles to `.s("native").vst('<channel id>')`. The `native`
  sound (src/native/nativeStudio.ts) doesn't create WebAudio nodes: it converts the event's AudioContext time into
  the moment it will be *heard* (`AudioContext.getOutputTimestamp()`), maps that onto the native high-resolution
  clock (synced every 10 s with a min-RTT ping), and sends `{track, note, velocity, time, duration}` batches.
* **AudioEngine** (Source/AudioEngine.cpp) receives the notes through a lock-free FIFO and places each note-on /
  note-off at the exact sample of the block that will be heard at that time (smoothed callback clock + device
  output latency + a user offset), then runs `instrument → effects` per track, applies volume/pan (same pan law as
  WebAudio's StereoPannerNode) and mixes to the device. Plug-ins get a play head (tempo, bar, PPQ, playing) from
  the transport the web side reports.
* **Tracks** mirror the project: `ss_syncTracks` creates / reuses / removes plug-in instances (created off the
  audio lock, swapped in with pointer moves; old instances are deleted on the message thread after their editor
  windows are closed).
* **Offline export**: while the web app renders its part with an `OfflineAudioContext`, the `native` sound
  collects the VST3 notes; the engine then renders them through the same plug-ins in non-realtime mode
  (`ss_render`), the WAV is fetched from `https://juce.backend/render/<id>.wav` and mixed into the export.
* **Plug-in state** (`getStateInformation`, base64) is embedded in project files (`nativeStates`) and kept in
  `session.json` in the app-data folder so the autosaved project comes back with its sounds.
* **MIDI** devices are opened by the engine; notes go straight to the selected VST3 channel (low latency) and are
  forwarded to the web UI (`ss_midi`) for recording and for non-VST channels.

App data (`%APPDATA%\StrudelStudio`, `~/.config/StrudelStudio`): `plugins.xml` (scan cache),
`audio-device.xml`, `session.json`, `settings.xml` (window). The WebView2 browser profile (autosave, imported
samples, caches) is in `%LOCALAPPDATA%\StrudelStudio\WebView2`.

## Bridge protocol

JUCE native functions, called from JS with `window.__JUCE__.backend.emitEvent('__juce__invoke', {name, params, resultId})`
(see src/native/bridge.ts):

| function | purpose |
| --- | --- |
| `ss_hello` | versions, platform, audio info, data folder, default plug-in folders, file to open |
| `ss_clock` | native clock (ms) for clock sync |
| `ss_listPlugins`, `ss_scanPlugins(folders, rescanAll)` | known plug-ins, background scan (`ss_scanProgress` / `ss_scanFinished` events) |
| `ss_syncTracks(tracks, master)` | `[{id, instrument, fx:[{slot, plugin, bypass}], volume, pan, mute}]` → track status |
| `ss_notes(events)` | `[{t: track, n: note, v: velocity, at: heard time (native ms), d: duration ms}]` |
| `ss_liveNote`, `ss_selectTrack`, `ss_panic`, `ss_transport` | live playing, MIDI routing, all-notes-off, play head |
| `ss_openEditor`, `ss_closeEditor` | plug-in editor windows (`ss_editor` event) |
| `ss_getState`, `ss_setState`, `ss_saveSession` | plug-in states |
| `ss_render`, `ss_renderSize`, `ss_readRender` | offline render (+ chunked base64 fallback) |
| `ss_chooseFile`, `ss_readFile`, `ss_writeFile`, `ss_fileInfo`, `ss_showInFolder` | files |
| `ss_audioInfo`, `ss_audioSettings`, `ss_setSyncOffset`, `ss_setTitle`, `ss_openUrl`, `ss_quit` | misc |

Events from native: `ss_status`, `ss_meters`, `ss_midi`, `ss_audio`, `ss_scanProgress`, `ss_scanFinished`,
`ss_editor`, `ss_openPath`.

## Building

```bash
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release    # downloads JUCE 9.0.2
cmake --build native/build
```

Options: `-DJUCE_DIR=/path/to/JUCE` (use a local checkout), `-DSTRUDEL_BUILD_TEST_SYNTH=OFF` (skip the example
plug-ins), `-DSTRUDEL_LTO=OFF` (faster links). On Windows CMake also downloads the Microsoft.Web.WebView2 NuGet
package (the loader is linked statically, the C runtime too: the .exe has no DLL dependencies besides the
WebView2 runtime that ships with Windows 10/11).

The app looks for the web app in `app/` next to the executable or in a parent folder. Environment variables for
development: `STRUDEL_STUDIO_WEB_ROOT` (web folder), `STRUDEL_STUDIO_DEV_URL` (e.g. the Vite dev server
`http://localhost:5173/`), `STRUDEL_STUDIO_TEST_SCRIPT` (JS file run in the page after load; used by
`tests/native-linux.sh` with `tests/native-e2e.js`).

### Cross-compiling the Windows build on Linux

The included `Strudel Studio.exe` was built this way (clang-cl + lld-link against the MSVC CRT / Windows SDK
downloaded with [xwin](https://github.com/Jake-Shadle/xwin)):

```bash
xwin --accept-license --arch x86_64 splat --output ~/xwin && export XWIN=~/xwin   # CRT + Windows SDK
# toolchain file: CMAKE_SYSTEM_NAME=Windows, clang-cl, lld-link, llvm-rc/llvm-mt/llvm-lib,
#   /imsvc ~/xwin/crt/include + sdk/include/{ucrt,um,shared,winrt,cppwinrt}, /libpath:… , CMAKE_TRY_COMPILE_CONFIGURATION=Release
cmake -S native -B build-win -G Ninja -DCMAKE_TOOLCHAIN_FILE=tools/win-clang-cl.cmake -DCMAKE_BUILD_TYPE=Release -DSTRUDEL_LTO=OFF
cmake --build build-win
```

(On a case-sensitive file system add links such as `Dwrite.lib → DWRITE.lib`, `D2d1.lib`, `DComp.lib`,
`DbgHelp.lib` in the SDK's `um/x86_64` folder. The example plug-ins are then built without the VST3 manifest.)
See `tools/win-clang-cl.cmake`.

## Example plug-ins

`TestSynth/` contains two small VST3 plug-ins built with the project: **Strudel Test Synth** (16-voice
sine/saw/square synth with ADSR and low-pass) and **Strudel Test Drive** (tanh drive, tone, mix). They're used by
the tests and are a starting point for writing your own plug-ins with JUCE.

## Limitations / ideas

* Strudel sounds play through the WebView's audio output, VST3 channels through the native device; they're
  time-aligned but not summed into one stream (a future version could stream the WebAudio output into the native
  engine through an AudioWorklet).
* VST3 channels don't pass through the Strudel mixer effects; volume/pan automation of VST3 channels isn't applied
  (plug-in parameters can be automated inside the plug-in).
* Plug-ins are scanned in-process; a plug-in that crashes during the scan is remembered and skipped next time.
