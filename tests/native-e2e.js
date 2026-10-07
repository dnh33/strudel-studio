// End-to-end test that runs INSIDE the native app's WebView.
// Started by the app when STRUDEL_STUDIO_TEST_SCRIPT points to this file (see tests/native-linux.sh).
// Reports with the ss_testLog / ss_testExit native functions.
(async () => {
  const backend = window.__JUCE__.backend;
  let id = 1e6;
  const call = (name, ...params) =>
    new Promise((resolve) => {
      const rid = id++;
      const h = backend.addEventListener('__juce__complete', (p) => {
        if (p.promiseId === rid) {
          backend.removeEventListener(h);
          resolve(p.result);
        }
      });
      backend.emitEvent('__juce__invoke', { name, params, resultId: rid });
    });
  const log = (m) => call('ss_testLog', String(m));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failures = 0;
  const ok = async (cond, msg) => {
    if (!cond) failures++;
    await log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  };
  const waitFor = async (fn, ms, step = 100) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* keep waiting */
      }
      await sleep(step);
    }
    return null;
  };

  try {
    await log('native e2e start · ' + location.href);
    const D = await waitFor(() => window.__studioDebug, 20000);
    await ok(!!D, 'studio loaded (__studioDebug)');
    const { getState, useStudio, actions: A, transport: T, engine, nativeStudio: NS, nativeBridge: NB } = D;
    await ok(NB.isNative, 'bridge detects the native app');

    const hello = await call('ss_hello');
    await log(`hello: ${hello.app} ${hello.version}, ${hello.juce}, ${hello.os}, audio ${hello.audio.type} "${hello.audio.device}" ${hello.audio.sampleRate} Hz / ${hello.audio.bufferSize}, running=${hello.audio.running}`);
    await ok(hello.audio.running, 'native audio device is running');

    // clock sync sanity
    await NB.syncClock();
    const n0 = await call('ss_clock');
    const diff = Math.abs(NB.nativeNow() - n0);
    await ok(diff < 50, `clock sync (|native - estimate| = ${diff.toFixed(1)} ms)`);

    // web audio engine (may be unavailable in a headless container)
    const status = await waitFor(() => (getState().engineStatus === 'ready' || getState().engineStatus === 'failed' ? getState().engineStatus : null), 60000, 250);
    await log('web audio engine: ' + status + ' · ' + getState().engineMessage);
    const webAudio = status === 'ready';

    // plug-ins: scan if the test plug-ins aren't known yet
    let plugins = await call('ss_listPlugins');
    if (!plugins.some((p) => p.name === 'Strudel Test Synth')) {
      await log('scanning for VST3 plug-ins…');
      NS.scanPlugins(true);
      await sleep(300);
      await waitFor(() => !NS.useNative.getState().scanning, 120000, 250);
      plugins = await call('ss_listPlugins');
    }
    await log('plug-ins: ' + plugins.map((p) => `${p.name} [${p.isInstrument ? 'inst' : 'fx'}]`).join(', '));
    const synth = plugins.find((p) => p.name === 'Strudel Test Synth');
    const drive = plugins.find((p) => p.name === 'Strudel Test Drive');
    await ok(!!synth && synth.isInstrument, 'Strudel Test Synth found (instrument)');
    await ok(!!drive && !drive.isInstrument, 'Strudel Test Drive found (effect)');
    await waitFor(() => NS.useNative.getState().plugins.length === plugins.length, 3000);

    // a VST3 channel with an effect
    const chId = A.addVstChannel(synth);
    A.addVstFx(chId, drive);
    const st = await waitFor(() => {
      const s = NS.useNative.getState().status[chId];
      return s && s.instrument && s.instrument.loaded && s.fx.length === 1 && s.fx[0].loaded ? s : null;
    }, 10000);
    await ok(!!st, 'native track created: instrument + effect loaded');
    await log('status: ' + JSON.stringify(NS.useNative.getState().status[chId]));

    // notes straight to the native engine (no Web Audio involved)
    const peakOf = () => NS.nativeMeters.data?.tracks?.[chId]?.[0] ?? 0;
    const maxPeak = async (ms) => {
      let m = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        m = Math.max(m, peakOf());
        await sleep(40);
      }
      return m;
    };
    await sleep(300);
    const quiet = await maxPeak(400);
    await ok(quiet < 0.001, `track is silent before notes (${quiet.toFixed(4)})`);
    const at = NB.nativeNow() + 150;
    await call('ss_notes', [60, 64, 67].map((n, i) => ({ t: chId, n, v: 0.9, at: at + i * 120, d: 300 })));
    const p1 = await maxPeak(1200);
    await ok(p1 > 0.02, `scheduled notes play through the VST3 chain (peak ${p1.toFixed(3)})`);
    await sleep(600);
    const after = await maxPeak(400);
    await ok(after < 0.001, `notes end with their note-offs (${after.toFixed(4)})`);

    // live notes (typing keyboard / MIDI path)
    await call('ss_liveNote', chId, 72, 1, true);
    const p2 = await maxPeak(500);
    await call('ss_liveNote', chId, 72, 0, false);
    await ok(p2 > 0.02, `live note-on sounds (peak ${p2.toFixed(3)})`);
    await sleep(600);
    await ok((await maxPeak(300)) < 0.001, 'live note-off stops it');

    // bypass + mute + volume are applied
    const ch = () => getState().project.channels.find((c) => c.id === chId);
    A.setChannel(chId, { mute: true });
    await sleep(200);
    await call('ss_notes', [{ t: chId, n: 60, v: 1, at: NB.nativeNow() + 100, d: 300 }]);
    await ok((await maxPeak(700)) < 0.001, 'muted channel is silent');
    A.setChannel(chId, { mute: false });

    // Strudel sequencing -> native (needs Web Audio for the scheduler clock)
    const pt = getState().patternId;
    A.setNotes(pt, chId, [
      { id: 'a', key: 60, start: 0, len: 48, vel: 1 },
      { id: 'b', key: 67, start: 96, len: 48, vel: 0.7 },
      { id: 'c', key: 72, start: 192, len: 96, vel: 0.9 },
    ]);
    const code = D.compileCurrent().code;
    await ok(code.includes(`.s("native").vst('${chId}')`), 'channel compiles to .s("native").vst(id)');
    if (webAudio) {
      useStudio.setState({ channelId: chId });
      getState().project.channels.forEach((c) => c.id !== chId && A.setChannel(c.id, { mute: true }));
      await log(`audio ctx before play: ${engine.ctx.state}`);
      const played = await Promise.race([T.play().then(() => 'started'), sleep(8000).then(() => 'play() timed out')]);
      await log('play: ' + played + ' · playing=' + getState().playing);
      const ctx = engine.ctx;
      const c0 = ctx.currentTime;
      const p3 = await maxPeak(3000);
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      await log(`audio ctx: state=${ctx.state} currentTime ${c0.toFixed(2)} -> ${ctx.currentTime.toFixed(2)}, outputLatency=${ctx.outputLatency}, baseLatency=${ctx.baseLatency}, outputTimestamp=${JSON.stringify(ts && { contextTime: ts.contextTime, performanceTime: ts.performanceTime })}, perf.now=${performance.now().toFixed(1)}`);
      await log(`native notes sent: ${JSON.stringify(NS.nativeStats)}, nativeNow=${NB.nativeNow().toFixed(1)}`);
      T.stop();
      const sentAtStop = NS.nativeStats.sent;
      await ok(p3 > 0.02, `Strudel pattern plays the VST3 channel (peak ${p3.toFixed(3)})`);
      const info = await call('ss_audioInfo');
      await log('note timing: ' + JSON.stringify(info.noteStats));
      await ok(info.noteStats.notes > 0 && info.noteStats.late === 0, `Strudel notes reach the engine ahead of time (min lead ${info.noteStats.minLeadMs.toFixed(1)} ms, late ${info.noteStats.late})`);
      const series = [];
      const tStop = performance.now();
      while (performance.now() - tStop < 1200) {
        series.push(`${Math.round(performance.now() - tStop)}:${peakOf().toFixed(3)}`);
        await sleep(40);
      }
      const tail = await maxPeak(300);
      if (tail >= 0.001) await log('after stop: ' + series.join(' '));
      await ok(tail < 0.001, `stop silences the VST3 channel (panic) (peak ${tail.toFixed(4)}, notes sent after stop: ${NS.nativeStats.sent - sentAtStop})`);

      // offline export: Strudel render + native render mixed
      const project = getState().project;
      const buf = await engine.renderBuffer({ code: D.compileCurrent(getState(), false).code, project, startBar: 0, bars: 1, tailSeconds: 0.5, sampleRate: 48000 });
      let peak = 0;
      const d0 = buf.getChannelData(0);
      for (let i = 0; i < d0.length; i++) peak = Math.max(peak, Math.abs(d0[i]));
      await ok(peak > 0.02, `offline export contains the VST3 channel (peak ${peak.toFixed(3)}, ${buf.duration.toFixed(2)} s)`);
      getState().project.channels.forEach((c) => c.id !== chId && A.setChannel(c.id, { mute: false }));
    } else {
      await log('skipping Strudel playback + offline export (no Web Audio here)');
    }

    // native offline render directly
    const r = await call('ss_render', {
      sampleRate: 48000,
      seconds: 1.5,
      bpm: 120,
      beatsPerBar: 4,
      startBar: 0,
      events: [
        { t: chId, n: 48, v: 1, at: 0, d: 400 },
        { t: chId, n: 55, v: 1, at: 500, d: 400 },
      ],
    });
    await ok(r && !r.error && r.peak > 0.02, `native offline render (${JSON.stringify(r)})`);
    if (r && r.url) {
      const buf = await NB.fetchRender(r.id, r.url);
      const wav = NB.parseWav(buf);
      const n = wav.channels[0].length;
      let pk = 0;
      for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(wav.channels[0][i]));
      await ok(wav.sampleRate === 48000 && Math.abs(n - 72000) < 10 && Math.abs(pk - r.peak) < 0.01, `render WAV fetched (${buf.byteLength} bytes, ${n} frames, peak ${pk.toFixed(3)})`);
      // silence before the first note / between notes checks sample accuracy
      const firstNonZero = wav.channels[0].findIndex((x) => Math.abs(x) > 1e-4);
      await ok(firstNonZero >= 0 && firstNonZero < 64, `render starts on time (first sample ${firstNonZero})`);
      const size = await call('ss_renderSize', r.id);
      const chunk = await call('ss_readRender', r.id, 0, 64);
      await ok(size === buf.byteLength && typeof chunk === 'string' && atob(chunk).startsWith('RIFF'), 'chunked render read fallback');
    }
    const status2 = await call('ss_trackStatus');
    await ok(status2.some((t) => t.id === chId && t.instrument.loaded), 'realtime chain restored after the render');
    await call('ss_notes', [{ t: chId, n: 64, v: 1, at: NB.nativeNow() + 100, d: 200 }]);
    await ok((await maxPeak(700)) > 0.02, 'plays again after the render');

    // plug-in state round trip
    const state = await call('ss_getState');
    const key = `${chId}|inst`;
    await ok(state[key] && state[key].state.length > 20, `plug-in state saved (${key}: ${state[key]?.state.length} chars)`);
    await ok(Object.keys(state).some((k) => k.startsWith(chId + '|vfx')), 'effect state saved');
    const withStates = await NS.projectWithStates(getState().project);
    await ok(withStates.nativeStates && withStates.nativeStates[key], 'project file embeds plug-in states');
    await ok((await call('ss_setState', state)) === true, 'plug-in state restore');

    // channel settings with the VST3 panel
    A.addVstFx(chId, drive);
    useStudio.setState({ settingsChannelId: chId, channelId: chId });
    getState().openWindow('channelSettings');
    await sleep(1200);
    await log('SCREENSHOT settings');
    await sleep(1200);
    getState().openWindow('channelSettings', false);

    // editor window
    const opened = await call('ss_openEditor', chId, 'inst', 'Strudel Test Synth — test', false);
    await ok(opened === true, 'plug-in editor window opens');
    await waitFor(() => NS.useNative.getState().editors[`${chId}|inst`], 2000);
    await ok(NS.useNative.getState().editors[`${chId}|inst`] === true, 'editor open state reported to the UI');
    await log('SCREENSHOT editor');
    await sleep(1500);
    await call('ss_closeEditor', chId, 'inst');

    // files
    const tmp = hello.dataFolder + '/e2e-test.txt';
    await call('ss_writeFile', tmp, 'hello ÆØÅ ✓', false, false);
    await call('ss_writeFile', tmp, NB.bytesToBase64(new TextEncoder().encode(' more')), true, true);
    const back = await call('ss_readFile', tmp, false);
    await ok(back === 'hello ÆØÅ ✓ more', `file write/append/read round trip (${back})`);

    // swap instrument / remove effect / remove channel
    for (const f of getState().project.channels.find((c) => c.id === chId).vst.fx) A.removeVstFx(chId, f.id);
    await ok(!!(await waitFor(() => NS.useNative.getState().status[chId]?.fx.length === 0, 3000)), 'effects removed from the native chain');
    A.deleteChannel(chId);
    await ok(!!(await waitFor(() => !NS.useNative.getState().status[chId], 3000)), 'track removed when the channel is deleted');
    getState().undo();
    await ok(!!(await waitFor(() => NS.useNative.getState().status[chId]?.instrument?.loaded, 5000)), 'undo brings the VST3 track back');
    A.deleteChannel(chId);
    await waitFor(() => !NS.useNative.getState().status[chId], 3000);
    await log('SCREENSHOT studio');
    await sleep(800);
  } catch (e) {
    failures++;
    await log('FAIL exception: ' + (e && e.stack ? e.stack : e));
  }
  await log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
  await call('ss_testExit', failures ? 1 : 0);
})();
0;
