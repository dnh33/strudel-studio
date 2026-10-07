#include "AudioEngine.h"

#include <set>

using namespace juce;

namespace
{
    constexpr int maxPendingPerTrack = 4096;
    constexpr int renderBlock = 512;                // offline render block size
    constexpr double lateNoteLimitMs = 1000.0;   // notes that arrive later than this are dropped
    const String instrumentSlotId = "inst";

    var toVar (DynamicObject* o) { return var (o); }

    float getFloat (const var& v, const Identifier& key, float fallback)
    {
        const auto& x = v[key];
        return x.isVoid() ? fallback : (float) (double) x;
    }

    // WebAudio StereoPannerNode law for a stereo source (keeps the native tracks consistent with the web mixer)
    void panGains (float pan, float& ll, float& rl, float& lr, float& rr)
    {
        // out L = ll*inL + rl*inR ; out R = lr*inL + rr*inR
        pan = jlimit (-1.0f, 1.0f, pan);

        if (pan <= 0.0f)
        {
            const auto x = (pan + 1.0f) * MathConstants<float>::halfPi;
            ll = 1.0f; rl = std::cos (x);
            lr = 0.0f; rr = std::sin (x);
        }
        else
        {
            const auto x = pan * MathConstants<float>::halfPi;
            ll = std::cos (x); rl = 0.0f;
            lr = std::sin (x); rr = 1.0f;
        }
    }
}

//==============================================================================
AudioEngine::AudioEngine (PluginHost& h) : host (h)
{
    liveBuffer.ensureSize (8192);
}

AudioEngine::~AudioEngine()
{
    cancelRender = true;

    if (renderThread.joinable())
        renderThread.join();

    stopTimer();
    deviceManager.removeAudioCallback (this);
    deviceManager.removeMidiInputDeviceCallback ({}, this);
    deviceManager.removeChangeListener (this);
    deviceManager.closeAudioDevice();

    // (the app closes all plug-in editor windows before the engine goes away)
    const ScopedLock sl (trackLock);
    tracks.clear();
}

//==============================================================================
void AudioEngine::initialiseAudio()
{
    auto xml = parseXML (PluginHost::getDataFolder().getChildFile ("audio-device.xml"));
    const auto error = deviceManager.initialise (0, 2, xml.get(), true);

    if (error.isNotEmpty())
        Logger::writeToLog ("Audio device error: " + error);

    // the saved device may be gone (unplugged interface, removed ASIO driver): use the system default
    if (deviceManager.getCurrentAudioDevice() == nullptr)
    {
        const auto fallbackError = deviceManager.initialiseWithDefaultDevices (0, 2);

        if (fallbackError.isNotEmpty())
            Logger::writeToLog ("Default audio device error: " + fallbackError);
    }

    enableAllMidiInputs();
    midiDevicesConnection = MidiDeviceListConnection::make ([this] { enableAllMidiInputs(); });

    deviceManager.addMidiInputDeviceCallback ({}, this);
    deviceManager.addAudioCallback (this);
    deviceManager.addChangeListener (this);
    startTimerHz (20);
}

void AudioEngine::enableAllMidiInputs()
{
    for (const auto& d : MidiInput::getAvailableDevices())
        if (! deviceManager.isMidiInputDeviceEnabled (d.identifier))
            deviceManager.setMidiInputDeviceEnabled (d.identifier, true);
}

void AudioEngine::saveDeviceSettings()
{
    if (auto xml = deviceManager.createStateXml())
        xml->writeTo (PluginHost::getDataFolder().getChildFile ("audio-device.xml"));
}

void AudioEngine::changeListenerCallback (ChangeBroadcaster*)
{
    saveDeviceSettings();

    if (onAudioChanged)
        onAudioChanged (getAudioInfo());
}

var AudioEngine::getAudioInfo() const
{
    auto* o = new DynamicObject();
    auto* dev = deviceManager.getCurrentAudioDevice();

    o->setProperty ("type", deviceManager.getCurrentAudioDeviceType());
    o->setProperty ("device", dev != nullptr ? dev->getName() : String());
    o->setProperty ("sampleRate", dev != nullptr ? dev->getCurrentSampleRate() : 0.0);
    o->setProperty ("bufferSize", dev != nullptr ? dev->getCurrentBufferSizeSamples() : 0);
    o->setProperty ("latencyMs", outputLatencyMs);
    o->setProperty ("running", audioRunning.load());
    o->setProperty ("cpu", deviceManager.getCpuUsage());
    o->setProperty ("syncOffsetMs", syncOffsetMs.load());

    Array<var> midi;
    for (const auto& d : MidiInput::getAvailableDevices())
        if (deviceManager.isMidiInputDeviceEnabled (d.identifier))
            midi.add (d.name);

    o->setProperty ("midiInputs", midi);

    auto* stats = new DynamicObject();
    stats->setProperty ("notes", statNotes.load());
    stats->setProperty ("late", statLate.load());
    stats->setProperty ("maxLateMs", statMaxLateMs.load());
    stats->setProperty ("minLeadMs", statMinLeadMs.load() > 1.0e8f ? 0.0f : statMinLeadMs.load());
    o->setProperty ("noteStats", var (stats));
    return toVar (o);
}

//==============================================================================
std::vector<AudioEngine::TrackSpec> AudioEngine::parseTracks (const var& tracksVar)
{
    std::vector<TrackSpec> result;

    if (auto* arr = tracksVar.getArray())
    {
        for (const auto& t : *arr)
        {
            TrackSpec spec;
            spec.id = t["id"].toString();
            spec.instrumentId = t["instrument"].toString();
            spec.volume = getFloat (t, "volume", 0.8f);
            spec.pan = getFloat (t, "pan", 0.0f);
            spec.mute = (bool) t["mute"];

            if (auto* fx = t["fx"].getArray())
            {
                for (const auto& f : *fx)
                {
                    FxSpec fs;
                    fs.slotId = f["slot"].toString();
                    fs.pluginId = f["plugin"].toString();
                    fs.bypass = (bool) f["bypass"];

                    if (fs.slotId.isNotEmpty() && fs.pluginId.isNotEmpty())
                        spec.fx.push_back (fs);
                }
            }

            if (spec.id.isNotEmpty())
                result.push_back (std::move (spec));
        }
    }

    return result;
}

AudioEngine::Track* AudioEngine::findTrack (const String& id) const
{
    for (auto& t : tracks)
        if (t->id == id)
            return t.get();

    return nullptr;
}

int AudioEngine::allocateSlotIndex()
{
    for (size_t i = 0; i < slotMap.size(); ++i)
    {
        const auto idx = (nextSlotIndex + (int) i) % (int) slotMap.size();

        if (! slotUsed[(size_t) idx])
        {
            slotUsed[(size_t) idx] = true;
            nextSlotIndex = (idx + 1) % (int) slotMap.size();
            return idx;
        }
    }

    return -1;
}

std::unique_ptr<AudioEngine::Slot> AudioEngine::createSlot (const String& trackId, const String& slotId, const String& pluginId)
{
    auto slot = std::make_unique<Slot>();
    slot->slotId = slotId;
    slot->pluginId = pluginId;

    if (auto desc = host.findByIdentifier (pluginId))
        slot->name = desc->name;

    String error;
    slot->plugin = host.createInstance (pluginId, sampleRate, blockSize, error);

    if (slot->plugin == nullptr)
    {
        slot->error = error;
        return slot;
    }

    slot->name = slot->plugin->getName();
    prepareSlot (*slot, sampleRate, blockSize, false);

    const auto key = stateKey (trackId, slotId);
    const auto it = pendingStates.find (key);

    if (it != pendingStates.end())
    {
        if (it->second.first == pluginId)
        {
            MemoryOutputStream data;

            if (Base64::convertFromBase64 (data, it->second.second))
                slot->plugin->setStateInformation (data.getData(), (int) data.getDataSize());
        }

        pendingStates.erase (it);
    }

    return slot;
}

void AudioEngine::prepareSlot (Slot& slot, double sr, int bs, bool nonRealtime)
{
    if (slot.plugin == nullptr)
        return;

    auto& p = *slot.plugin;
    p.releaseResources();
    p.setPlayHead (this);

    // Prefer a plain stereo main bus in and out.
    auto layout = p.getBusesLayout();

    if (! layout.outputBuses.isEmpty())
        layout.outputBuses.getReference (0) = AudioChannelSet::stereo();

    if (! layout.inputBuses.isEmpty())
        layout.inputBuses.getReference (0) = AudioChannelSet::stereo();

    if (layout != p.getBusesLayout() && p.checkBusesLayoutSupported (layout))
        p.setBusesLayout (layout);

    p.setNonRealtime (nonRealtime);
    p.setRateAndBufferSizeDetails (sr, bs);
    p.prepareToPlay (sr, bs);
}

int AudioEngine::channelsNeeded (const Track& t)
{
    int ch = 2;

    auto check = [&ch] (const std::unique_ptr<Slot>& s)
    {
        if (s != nullptr && s->plugin != nullptr)
            ch = jmax (ch, s->plugin->getTotalNumInputChannels(), s->plugin->getTotalNumOutputChannels());
    };

    check (t.instrument);

    for (auto& f : t.fx)
        check (f);

    return ch;
}

void AudioEngine::allocateBuffers (Track& t, int bs)
{
    t.buffer.setSize (channelsNeeded (t), jmax (bs, 64), false, true, false);
    t.midi.ensureSize (8192);

    if (t.pending.capacity() < (size_t) maxPendingPerTrack)
        t.pending.reserve ((size_t) maxPendingPerTrack);
}

void AudioEngine::prepareAll (double sr, int bs, bool nonRealtime)
{
    for (auto& t : tracks)
    {
        if (t->instrument != nullptr)
            prepareSlot (*t->instrument, sr, bs, nonRealtime);

        for (auto& f : t->fx)
            prepareSlot (*f, sr, bs, nonRealtime);

        allocateBuffers (*t, bs);
        t->pending.clear();
        t->held.fill (false);
    }
}

//==============================================================================
void AudioEngine::syncTracks (const std::vector<TrackSpec>& specs, float master)
{
    if (rendering)
    {
        deferredSpecs = specs;
        deferredMaster = master;
        hasDeferred = true;
        return;
    }

    masterVolume = master;

    struct Change
    {
        Track* existing = nullptr;
        std::unique_ptr<Track> fresh;
        bool instrumentChanged = false;
        std::unique_ptr<Slot> instrument;
        bool fxChanged = false;
        std::vector<std::unique_ptr<Slot>> fx;   // final chain; nullptr = reuse the old slot at reuse[i]
        std::vector<int> reuse;
        AudioBuffer<float> buffer;
    };

    std::vector<Change> changes;
    bool structureChanged = false;

    // 1. create the new plug-in instances (slow) without holding the audio lock
    for (const auto& spec : specs)
    {
        Change c;
        c.existing = findTrack (spec.id);

        if (c.existing == nullptr)
        {
            const auto idx = allocateSlotIndex();

            if (idx < 0)
                continue;

            c.fresh = std::make_unique<Track>();
            c.fresh->id = spec.id;
            c.fresh->slotIndex = idx;
            c.fresh->volume = spec.volume;
            c.fresh->pan = spec.pan;
            c.fresh->mute = spec.mute;

            if (spec.instrumentId.isNotEmpty())
                c.fresh->instrument = createSlot (spec.id, instrumentSlotId, spec.instrumentId);

            for (const auto& f : spec.fx)
            {
                auto s = createSlot (spec.id, f.slotId, f.pluginId);
                s->bypass = f.bypass;
                c.fresh->fx.push_back (std::move (s));
            }

            allocateBuffers (*c.fresh, blockSize);
            structureChanged = true;
            changes.push_back (std::move (c));
            continue;
        }

        auto& t = *c.existing;
        t.volume = spec.volume;
        t.pan = spec.pan;
        t.mute = spec.mute;

        const auto currentInstrument = t.instrument != nullptr ? t.instrument->pluginId : String();

        if (currentInstrument != spec.instrumentId)
        {
            c.instrumentChanged = true;

            if (spec.instrumentId.isNotEmpty())
                c.instrument = createSlot (spec.id, instrumentSlotId, spec.instrumentId);
        }

        for (size_t i = 0; i < spec.fx.size(); ++i)
        {
            const auto& f = spec.fx[i];
            int found = -1;

            for (size_t j = 0; j < t.fx.size(); ++j)
                if (t.fx[j] != nullptr && t.fx[j]->slotId == f.slotId && t.fx[j]->pluginId == f.pluginId)
                    found = (int) j;

            if (found >= 0)
            {
                t.fx[(size_t) found]->bypass = f.bypass;
                c.fx.push_back (nullptr);
                c.reuse.push_back (found);

                if (found != (int) i)
                    c.fxChanged = true;
            }
            else
            {
                auto s = createSlot (spec.id, f.slotId, f.pluginId);
                s->bypass = f.bypass;
                c.fx.push_back (std::move (s));
                c.reuse.push_back (-1);
                c.fxChanged = true;
            }
        }

        if (spec.fx.size() != t.fx.size())
            c.fxChanged = true;

        if (c.instrumentChanged || c.fxChanged)
        {
            int ch = 2;
            auto count = [&ch] (const std::unique_ptr<Slot>& s)
            {
                if (s != nullptr && s->plugin != nullptr)
                    ch = jmax (ch, s->plugin->getTotalNumInputChannels(), s->plugin->getTotalNumOutputChannels());
            };

            count (c.instrumentChanged ? c.instrument : t.instrument);

            for (size_t i = 0; i < c.fx.size(); ++i)
                count (c.reuse[i] >= 0 ? t.fx[(size_t) c.reuse[i]] : c.fx[i]);

            c.buffer.setSize (ch, jmax (blockSize, 64));
            structureChanged = true;
            changes.push_back (std::move (c));
        }
    }

    // tracks that are gone
    std::vector<Track*> removed;

    for (auto& t : tracks)
    {
        const auto stillThere = std::any_of (specs.begin(), specs.end(), [&] (const TrackSpec& s) { return s.id == t->id; });

        if (! stillThere)
        {
            removed.push_back (t.get());
            structureChanged = true;
        }
    }

    if (! structureChanged)
        return;

    std::vector<std::pair<String, std::unique_ptr<Slot>>> garbageSlots;
    std::vector<std::unique_ptr<Track>> garbageTracks;

    // 2. swap everything in while the audio thread is locked out (pointer moves only)
    {
        const ScopedLock sl (trackLock);

        for (auto& c : changes)
        {
            if (c.fresh != nullptr)
            {
                slotMap[(size_t) c.fresh->slotIndex] = c.fresh.get();
                tracks.push_back (std::move (c.fresh));
                continue;
            }

            auto& t = *c.existing;

            if (c.instrumentChanged)
            {
                if (t.instrument != nullptr)
                    garbageSlots.emplace_back (t.id, std::move (t.instrument));

                t.instrument = std::move (c.instrument);
                t.held.fill (false);
            }

            if (c.fxChanged)
            {
                std::vector<std::unique_ptr<Slot>> chain;

                for (size_t i = 0; i < c.fx.size(); ++i)
                    chain.push_back (c.reuse[i] >= 0 ? std::move (t.fx[(size_t) c.reuse[i]]) : std::move (c.fx[i]));

                for (auto& old : t.fx)
                    if (old != nullptr)
                        garbageSlots.emplace_back (t.id, std::move (old));

                t.fx = std::move (chain);
            }

            std::swap (t.buffer, c.buffer);
        }

        for (auto* r : removed)
        {
            slotMap[(size_t) r->slotIndex] = nullptr;
            slotUsed[(size_t) r->slotIndex] = false;

            for (auto it = tracks.begin(); it != tracks.end(); ++it)
            {
                if (it->get() == r)
                {
                    garbageTracks.push_back (std::move (*it));
                    tracks.erase (it);
                    break;
                }
            }
        }
    }

    // 3. delete the old instances on the message thread, after closing their editors.
    //    Their states are kept, so undoing a delete / plug-in swap brings the sound back.
    auto keepState = [this] (const String& trackId, Slot& slot)
    {
        if (slot.plugin == nullptr)
            return;

        MemoryBlock mb;
        slot.plugin->getStateInformation (mb);
        pendingStates[stateKey (trackId, slot.slotId)] = { slot.pluginId, Base64::toBase64 (mb.getData(), mb.getSize()) };
    };

    for (auto& g : garbageSlots)
    {
        keepState (g.first, *g.second);

        if (onPluginRemoved)
            onPluginRemoved (g.first, g.second->slotId);
    }

    for (auto& t : garbageTracks)
    {
        if (t->instrument != nullptr) keepState (t->id, *t->instrument);
        for (auto& f : t->fx) keepState (t->id, *f);
    }

    for (auto& t : garbageTracks)
    {
        if (onPluginRemoved)
        {
            if (t->instrument != nullptr) onPluginRemoved (t->id, t->instrument->slotId);
            for (auto& f : t->fx) onPluginRemoved (t->id, f->slotId);
        }
    }

    garbageSlots.clear();
    garbageTracks.clear();

    notifyStatus();
}

//==============================================================================
void AudioEngine::pushEvent (const NoteEvent& e)
{
    const ScopedLock sl (fifoWriteLock);
    int s1, z1, s2, z2;
    fifo.prepareToWrite (1, s1, z1, s2, z2);

    if (z1 > 0)
        fifoData[(size_t) s1] = e;
    else if (z2 > 0)
        fifoData[(size_t) s2] = e;

    fifo.finishedWrite (z1 + z2);
}

int AudioEngine::scheduleNotes (const var& events)
{
    auto* arr = events.getArray();

    if (arr == nullptr)
        return 0;

    const auto offset = syncOffsetMs.load();
    int count = 0;

    for (const auto& e : *arr)
    {
        auto* t = findTrack (e["t"].toString());

        if (t == nullptr)
            continue;

        NoteEvent ev;
        ev.type = NoteEvent::scheduled;
        ev.trackSlot = t->slotIndex;
        ev.note = jlimit (0, 127, (int) e["n"]);
        ev.velocity = jlimit (0.0f, 1.0f, getFloat (e, "v", 0.8f));
        ev.onMs = (double) e["at"] + offset;
        ev.offMs = ev.onMs + jmax (1.0, (double) e["d"]);
        pushEvent (ev);
        ++count;
    }

    return count;
}

void AudioEngine::playLiveNote (const String& trackId, int note, float velocity, bool isOn)
{
    if (auto* t = findTrack (trackId))
    {
        NoteEvent ev;
        ev.type = isOn ? NoteEvent::liveOn : NoteEvent::liveOff;
        ev.trackSlot = t->slotIndex;
        ev.note = jlimit (0, 127, note);
        ev.velocity = jlimit (0.0f, 1.0f, velocity);
        pushEvent (ev);
    }
}

void AudioEngine::panic()
{
    NoteEvent ev;
    ev.type = NoteEvent::panic;
    pushEvent (ev);
}

void AudioEngine::setTransport (bool playing, double bpm, int beatsPerBar, double bar, double atMs)
{
    const SpinLock::ScopedLockType sl (transportLock);
    transport.playing = playing;
    transport.bpm = jlimit (10.0, 999.0, bpm);
    transport.beatsPerBar = jlimit (1, 32, beatsPerBar);
    transport.bar = bar;
    transport.atMs = atMs + syncOffsetMs.load();
}

void AudioEngine::setSelectedTrack (const String& trackId)
{
    auto* t = findTrack (trackId);
    selectedSlot = t != nullptr ? t->slotIndex : -1;
}

void AudioEngine::drainFifo()
{
    int s1, z1, s2, z2;
    fifo.prepareToRead (fifo.getNumReady(), s1, z1, s2, z2);

    auto handle = [this] (const NoteEvent& e)
    {
        if (e.type == NoteEvent::panic)
        {
            for (auto& t : tracks)
            {
                t->pending.clear();
                t->killNotes = true;
            }

            return;
        }

        if (e.trackSlot < 0 || e.trackSlot >= (int) slotMap.size())
            return;

        auto* t = slotMap[(size_t) e.trackSlot];

        if (t == nullptr || t->pending.size() >= (size_t) maxPendingPerTrack)
            return;

        PendingNote p;
        p.note = e.note;
        p.velocity = e.velocity;

        if (e.type == NoteEvent::scheduled)
        {
            statMinLeadMs = jmin (statMinLeadMs.load(), (float) (e.onMs - currentBlockMs));
            p.timeMs = e.onMs;
            p.offTimeMs = e.offMs;
            p.isOn = true;
        }
        else
        {
            // live notes: play at the start of the next block
            p.timeMs = -1.0e12;
            p.offTimeMs = e.type == NoteEvent::liveOn ? 1.0e18 : 0.0;
            p.isOn = e.type == NoteEvent::liveOn;
            p.gen = 0xffffffff; // live note-off: always matches (see processTrack)
        }

        t->pending.push_back (p);
    };

    for (int i = 0; i < z1; ++i) handle (fifoData[(size_t) (s1 + i)]);
    for (int i = 0; i < z2; ++i) handle (fifoData[(size_t) (s2 + i)]);

    fifo.finishedRead (z1 + z2);
}

//==============================================================================
void AudioEngine::processTrack (Track& t, int n, double startMs, double msPerSample, const MidiBuffer* live, int liveStart)
{
    t.midi.clear();

    if (t.killNotes)
    {
        for (int note = 0; note < 128; ++note)
            if (t.held[(size_t) note])
                t.midi.addEvent (MidiMessage::noteOff (1, note), 0);

        t.midi.addEvent (MidiMessage::allNotesOff (1), 0);
        t.midi.addEvent (MidiMessage::allSoundOff (1), 0);
        t.held.fill (false);
        t.killNotes = false;
    }

    const double endMs = startMs + n * msPerSample;

    // Keeps the order of the pending list (important for fast repeated live notes).
    size_t keepCount = 0;

    for (size_t i = 0; i < t.pending.size(); ++i)
    {
        auto p = t.pending[i];
        bool keep = true;

        while (keep && p.timeMs < endMs)
        {
            const auto isLive = p.timeMs < -1.0e11;
            const auto note = (size_t) p.note;

            if (p.isOn)
            {
                const auto lateness = startMs - p.timeMs;

                if (! isLive && lateness > lateNoteLimitMs)
                {
                    keep = false;
                    break;
                }

                const auto offset = jlimit (0, n - 1, (int) ((p.timeMs - startMs) / msPerSample));

                if (! isLive && ! rendering.load())
                {
                    ++statNotes;

                    if (lateness > 0.0)
                    {
                        // tiny amounts come from the callback-clock smoothing; only count audible ones
                        if (lateness > 5.0)
                            ++statLate;

                        statMaxLateMs = jmax (statMaxLateMs.load(), (float) lateness);
                    }
                }

                if (t.held[note])
                    t.midi.addEvent (MidiMessage::noteOff (1, p.note), offset);

                t.midi.addEvent (MidiMessage::noteOn (1, p.note, jmax (1.0f / 127.0f, p.velocity)), offset);
                t.held[note] = true;
                ++t.gen[note];

                if (isLive)
                {
                    keep = false; // held until the live note-off arrives
                    break;
                }

                // becomes the matching note-off (which may be due in this block as well)
                p.isOn = false;
                p.gen = t.gen[note];
                p.timeMs = p.offTimeMs + jmax (0.0, lateness);
                continue;
            }

            const auto offset = isLive ? 0 : jlimit (0, n - 1, (int) ((p.timeMs - startMs) / msPerSample));

            if (t.held[note] && (isLive || t.gen[note] == p.gen))
            {
                t.midi.addEvent (MidiMessage::noteOff (1, p.note), offset);
                t.held[note] = false;
            }

            keep = false;
        }

        if (keep)
            t.pending[keepCount++] = p;
    }

    t.pending.resize (keepCount);

    if (live != nullptr)
    {
        for (const auto meta : *live)
        {
            const auto pos = meta.samplePosition - liveStart;

            if (pos >= 0 && pos < n)
                t.midi.addEvent (meta.data, meta.numBytes, pos);
        }
    }

    runChain (t, n);
}

void AudioEngine::runChain (Track& t, int n)
{
    const auto numCh = t.buffer.getNumChannels();
    AudioBuffer<float> view (t.buffer.getArrayOfWritePointers(), numCh, n);
    view.clear();

    auto process = [&view, &t] (Slot& s)
    {
        auto* p = s.plugin.get();

        if (p == nullptr || s.bypass.load())
            return;

        const ScopedLock pl (p->getCallbackLock());

        if (p->isSuspended())
            return;

        p->processBlock (view, t.midi);

        if (p->getTotalNumOutputChannels() == 1 && view.getNumChannels() > 1)
            view.copyFrom (1, 0, view, 0, 0, view.getNumSamples());
    };

    if (t.instrument != nullptr)
        process (*t.instrument);

    for (auto& f : t.fx)
    {
        t.midi.clear();
        process (*f);
    }
}

void AudioEngine::mixTrack (Track& t, float* const* out, int numOut, int offset, int n, float master, bool updateMeters)
{
    if (t.buffer.getNumChannels() < 2)
        return;

    const auto* inL = t.buffer.getReadPointer (0);
    const auto* inR = t.buffer.getReadPointer (1);

    float ll, rl, lr, rr;
    panGains (t.pan.load(), ll, rl, lr, rr);
    const auto gain = t.mute.load() ? 0.0f : t.volume.load();

    float pkL = 0.0f, pkR = 0.0f;
    float* oL = numOut > 0 ? out[0] : nullptr;
    float* oR = numOut > 1 ? out[1] : nullptr;

    for (int i = 0; i < n; ++i)
    {
        const auto l = (ll * inL[i] + rl * inR[i]) * gain;
        const auto r = (lr * inL[i] + rr * inR[i]) * gain;
        pkL = jmax (pkL, std::abs (l));
        pkR = jmax (pkR, std::abs (r));

        if (oR != nullptr)
        {
            if (oL != nullptr) oL[offset + i] += l * master;
            oR[offset + i] += r * master;
        }
        else if (oL != nullptr)
        {
            oL[offset + i] += 0.5f * (l + r) * master;
        }
    }

    if (! updateMeters)
        return;

    if (pkL > t.peakL.load()) t.peakL = pkL;
    if (pkR > t.peakR.load()) t.peakR = pkR;
}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const*, int,
                                                    float* const* out, int numOut,
                                                    int numSamples, const AudioIODeviceCallbackContext&)
{
    for (int ch = 0; ch < numOut; ++ch)
        if (out[ch] != nullptr)
            FloatVectorOperations::clear (out[ch], numSamples);

    if (rendering.load())
        return;

    const ScopedTryLock sl (trackLock);

    if (! sl.isLocked())
        return;

    // When is the first sample of this block heard? (smoothed callback time + output latency)
    const auto now = clockMs();
    const auto msPerSample = 1000.0 / sampleRate;
    const auto blockLenMs = numSamples * msPerSample;
    const auto expected = lastBlockStartMs + lastBlockLenMs;
    double blockStart = now;

    if (lastBlockStartMs > 0.0 && std::abs (now - expected) < jmax (20.0, 3.0 * blockLenMs))
        blockStart = expected + (now - expected) * 0.02;

    lastBlockStartMs = blockStart;
    lastBlockLenMs = blockLenMs;

    const auto heardStart = blockStart + outputLatencyMs;
    currentBlockMs = heardStart;

    drainFifo();

    liveBuffer.clear();
    liveMidi.removeNextBlockOfMessages (liveBuffer, numSamples);

    const auto master = masterVolume.load();
    const auto selected = selectedSlot.load();
    float mL = 0.0f, mR = 0.0f;

    for (int done = 0; done < numSamples;)
    {
        const auto n = jmin (blockSize, numSamples - done);
        const auto chunkStart = heardStart + done * msPerSample;
        currentBlockMs = chunkStart;

        for (auto& t : tracks)
        {
            const auto* live = (t->slotIndex == selected && ! liveBuffer.isEmpty()) ? &liveBuffer : nullptr;
            processTrack (*t, n, chunkStart, msPerSample, live, done);
            mixTrack (*t, out, numOut, done, n, master);
        }

        done += n;
    }

    if (numOut > 0 && out[0] != nullptr) mL = FloatVectorOperations::findMaximum (out[0], numSamples);
    if (numOut > 1 && out[1] != nullptr) mR = FloatVectorOperations::findMaximum (out[1], numSamples);

    if (numOut > 0 && out[0] != nullptr) mL = jmax (mL, -FloatVectorOperations::findMinimum (out[0], numSamples));
    if (numOut > 1 && out[1] != nullptr) mR = jmax (mR, -FloatVectorOperations::findMinimum (out[1], numSamples));

    if (mL > masterPeakL.load()) masterPeakL = mL;
    if (mR > masterPeakR.load()) masterPeakR = mR;
}

void AudioEngine::audioDeviceAboutToStart (AudioIODevice* device)
{
    sampleRate = device->getCurrentSampleRate();
    blockSize = jmax (16, device->getCurrentBufferSizeSamples());
    outputLatencyMs = (device->getOutputLatencyInSamples() + blockSize) * 1000.0 / sampleRate;
    lastBlockStartMs = 0.0;
    liveMidi.reset (sampleRate);

    {
        const ScopedLock sl (trackLock);
        prepareAll (sampleRate, blockSize, false);
    }

    audioRunning = true;

    MessageManager::callAsync ([weak = WeakReference<AudioEngine> (this)]
    {
        if (auto* self = weak.get())
            if (self->onAudioChanged)
                self->onAudioChanged (self->getAudioInfo());
    });
}

void AudioEngine::audioDeviceStopped()
{
    audioRunning = false;
}

Optional<AudioPlayHead::PositionInfo> AudioEngine::getPosition() const
{
    TransportState t;
    {
        const SpinLock::ScopedLockType sl (transportLock);
        t = transport;
    }

    PositionInfo info;
    const auto msPerBar = 60000.0 / t.bpm * t.beatsPerBar;
    const auto bars = jmax (0.0, t.bar + (t.playing ? (currentBlockMs - t.atMs) / msPerBar : 0.0));
    const auto ppq = bars * t.beatsPerBar;
    const auto seconds = ppq * 60.0 / t.bpm;

    info.setIsPlaying (t.playing);
    info.setBpm (t.bpm);
    info.setTimeSignature (AudioPlayHead::TimeSignature { t.beatsPerBar, 4 });
    info.setPpqPosition (ppq);
    info.setPpqPositionOfLastBarStart (std::floor (bars) * t.beatsPerBar);
    info.setBarCount ((int64_t) std::floor (bars));
    info.setTimeInSeconds (seconds);
    info.setTimeInSamples ((int64_t) (seconds * sampleRate));
    return info;
}

//==============================================================================
void AudioEngine::handleIncomingMidiMessage (MidiInput* source, const MidiMessage& m)
{
    if (m.isActiveSense() || m.isMidiClock())
        return;

    liveMidi.addMessageToQueue (m);

    if (m.isNoteOnOrOff() || m.isController() || m.isPitchWheel())
    {
        auto* o = new DynamicObject();
        o->setProperty ("type", m.isNoteOn() ? "on" : m.isNoteOff() ? "off" : m.isController() ? "cc" : "pitch");
        o->setProperty ("note", m.isNoteOnOrOff() ? m.getNoteNumber() : m.isController() ? m.getControllerNumber() : 0);
        o->setProperty ("value", m.isNoteOnOrOff() ? m.getFloatVelocity()
                                  : m.isController() ? m.getControllerValue() / 127.0f
                                                     : (m.getPitchWheelValue() - 8192) / 8192.0f);
        o->setProperty ("channel", m.getChannel());
        o->setProperty ("device", source != nullptr ? source->getName() : String());
        o->setProperty ("time", clockMs());
        var msg (o);

        MessageManager::callAsync ([weak = WeakReference<AudioEngine> (this), msg]
        {
            if (auto* self = weak.get())
                if (self->onMidiIn)
                    self->onMidiIn (msg);
        });
    }
}

void AudioEngine::timerCallback()
{
    if (! onMeters)
        return;

    auto* o = new DynamicObject();
    const auto l = masterPeakL.exchange (0.0f), r = masterPeakR.exchange (0.0f);
    bool silent = l < 1.0e-5f && r < 1.0e-5f;

    o->setProperty ("master", Array<var> { l, r });

    auto* tr = new DynamicObject();

    for (auto& t : tracks)
    {
        const auto tl = t->peakL.exchange (0.0f), trr = t->peakR.exchange (0.0f);
        silent = silent && tl < 1.0e-5f && trr < 1.0e-5f;
        tr->setProperty (t->id, Array<var> { tl, trr });
    }

    o->setProperty ("tracks", var (tr));
    o->setProperty ("cpu", deviceManager.getCpuUsage());

    const var meters (o);

    if (silent && metersWereSilent)
        return;

    metersWereSilent = silent;
    onMeters (meters);
}

//==============================================================================
var AudioEngine::getTrackStatus() const
{
    Array<var> result;

    auto describe = [] (const Slot& s)
    {
        auto* o = new DynamicObject();
        o->setProperty ("slot", s.slotId);
        o->setProperty ("plugin", s.pluginId);
        o->setProperty ("name", s.name);
        o->setProperty ("error", s.error);
        o->setProperty ("loaded", s.plugin != nullptr);
        o->setProperty ("hasEditor", s.plugin != nullptr && s.plugin->hasEditor());
        o->setProperty ("latency", s.plugin != nullptr ? s.plugin->getLatencySamples() : 0);
        o->setProperty ("bypass", s.bypass.load());
        return var (o);
    };

    for (auto& t : tracks)
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", t->id);
        o->setProperty ("instrument", t->instrument != nullptr ? describe (*t->instrument) : var());

        Array<var> fx;
        for (auto& f : t->fx)
            fx.add (describe (*f));

        o->setProperty ("fx", fx);
        result.add (var (o));
    }

    return result;
}

void AudioEngine::notifyStatus()
{
    if (onStatusChanged)
        onStatusChanged (getTrackStatus());
}

AudioPluginInstance* AudioEngine::findPlugin (const String& trackId, const String& slotId) const
{
    if (auto* t = findTrack (trackId))
    {
        if (slotId == instrumentSlotId)
            return t->instrument != nullptr ? t->instrument->plugin.get() : nullptr;

        for (auto& f : t->fx)
            if (f->slotId == slotId)
                return f->plugin.get();
    }

    return nullptr;
}

String AudioEngine::describeSlot (const String& trackId, const String& slotId) const
{
    if (auto* p = findPlugin (trackId, slotId))
        return p->getName();

    return {};
}

//==============================================================================
var AudioEngine::getState()
{
    auto* o = new DynamicObject();

    auto save = [o] (const String& key, Slot& s)
    {
        if (s.plugin == nullptr)
            return;

        MemoryBlock mb;
        s.plugin->getStateInformation (mb);

        auto* entry = new DynamicObject();
        entry->setProperty ("plugin", s.pluginId);
        entry->setProperty ("state", Base64::toBase64 (mb.getData(), mb.getSize()));
        o->setProperty (key, var (entry));
    };

    for (auto& t : tracks)
    {
        if (t->instrument != nullptr)
            save (stateKey (t->id, t->instrument->slotId), *t->instrument);

        for (auto& f : t->fx)
            save (stateKey (t->id, f->slotId), *f);
    }

    // keep states of plug-ins that couldn't be loaded (so they aren't lost when saving)
    for (auto& [key, value] : pendingStates)
    {
        if (! o->hasProperty (key))
        {
            auto* entry = new DynamicObject();
            entry->setProperty ("plugin", value.first);
            entry->setProperty ("state", value.second);
            o->setProperty (key, var (entry));
        }
    }

    return var (o);
}

void AudioEngine::setState (const var& state)
{
    auto* o = state.getDynamicObject();

    if (o == nullptr)
        return;

    for (auto& prop : o->getProperties())
    {
        const auto key = prop.name.toString();
        const auto pluginId = prop.value["plugin"].toString();
        const auto data = prop.value["state"].toString();

        const auto trackId = key.upToFirstOccurrenceOf ("|", false, false);
        const auto slotId = key.fromFirstOccurrenceOf ("|", false, false);
        auto* p = rendering ? nullptr : findPlugin (trackId, slotId);

        bool applied = false;

        if (p != nullptr)
        {
            auto* t = findTrack (trackId);
            const Slot* slot = nullptr;

            if (slotId == instrumentSlotId)
                slot = t->instrument.get();
            else
                for (auto& f : t->fx)
                    if (f->slotId == slotId)
                        slot = f.get();

            if (slot != nullptr && slot->pluginId == pluginId)
            {
                MemoryOutputStream mo;

                if (Base64::convertFromBase64 (mo, data))
                    p->setStateInformation (mo.getData(), (int) mo.getDataSize());

                applied = true;
            }
        }

        if (! applied)
            pendingStates[key] = { pluginId, data };
    }
}

void AudioEngine::saveSession()
{
    auto* o = new DynamicObject();
    o->setProperty ("version", 1);
    o->setProperty ("pluginStates", getState());
    o->setProperty ("syncOffsetMs", syncOffsetMs.load());

    PluginHost::getDataFolder().getChildFile ("session.json").replaceWithText (JSON::toString (var (o)));
}

void AudioEngine::loadSession()
{
    const auto parsed = JSON::parse (PluginHost::getDataFolder().getChildFile ("session.json"));

    if (! parsed.isObject())
        return;

    syncOffsetMs = (double) parsed["syncOffsetMs"];
    setState (parsed["pluginStates"]);
}

//==============================================================================
void AudioEngine::renderOffline (const var& request, std::function<void (var)> done)
{
    auto fail = [&done] (const String& message)
    {
        auto* o = new DynamicObject();
        o->setProperty ("error", message);
        done (var (o));
    };

    if (rendering)
        return fail ("A render is already running");

    if (renderThread.joinable())
        renderThread.join();

    const auto sr = jlimit (8000.0, 192000.0, request["sampleRate"].isVoid() ? 48000.0 : (double) request["sampleRate"]);
    const auto seconds = jlimit (0.1, 3600.0, (double) request["seconds"]);
    const auto totalSamples = (int64) (seconds * sr);

    // The audio callback is removed so the plug-ins belong to the render thread.
    rendering = true;
    deviceManager.removeAudioCallback (this);

    {
        const SpinLock::ScopedLockType sl (transportLock);
        savedTransport = transport;
        transport.playing = true;
        transport.bpm = request["bpm"].isVoid() ? 120.0 : (double) request["bpm"];
        transport.beatsPerBar = request["beatsPerBar"].isVoid() ? 4 : (int) request["beatsPerBar"];
        transport.bar = (double) request["startBar"];
        transport.atMs = 0.0;
    }

    // plug-ins must be (re)prepared on the message thread, in offline mode
    const auto renderSampleRate = sampleRate;
    sampleRate = sr;
    prepareAll (sr, renderBlock, true);
    sampleRate = renderSampleRate;

    for (auto& t : tracks)
    {
        t->killNotes = false;

        if (t->instrument != nullptr && t->instrument->plugin != nullptr)
            t->instrument->plugin->reset();

        for (auto& f : t->fx)
            if (f->plugin != nullptr)
                f->plugin->reset();
    }

    // notes, in ms from the render start
    if (auto* arr = request["events"].getArray())
    {
        for (const auto& e : *arr)
        {
            auto* t = findTrack (e["t"].toString());

            if (t == nullptr || t->pending.size() >= (size_t) maxPendingPerTrack * 64)
                continue;

            PendingNote p;
            p.note = jlimit (0, 127, (int) e["n"]);
            p.velocity = jlimit (0.0f, 1.0f, getFloat (e, "v", 0.8f));
            p.timeMs = (double) e["at"];
            p.offTimeMs = p.timeMs + jmax (1.0, (double) e["d"]);
            p.isOn = true;
            t->pending.push_back (p);
        }
    }

    // only tracks listed in `tracks` (if given) are rendered
    std::set<String> include;

    if (auto* arr = request["tracks"].getArray())
        for (const auto& id : *arr)
            include.insert (id.toString());

    const auto id = String (++renderCounter);
    const auto master = masterVolume.load();
    cancelRender = false;

    renderThread = std::thread ([this, sr, totalSamples, id, master, include, done,
                                 weak = WeakReference<AudioEngine> (this)]
    {
        AudioBuffer<float> mix (2, (int) totalSamples);
        mix.clear();
        const auto msPerSample = 1000.0 / sr;
        String error;

        for (int64 pos = 0; pos < totalSamples && ! cancelRender.load(); pos += renderBlock)
        {
            const auto n = (int) jmin ((int64) renderBlock, totalSamples - pos);
            const auto startMs = (double) pos * msPerSample;
            currentBlockMs = startMs;
            float* outs[2] = { mix.getWritePointer (0), mix.getWritePointer (1) };

            for (auto& t : tracks)
            {
                if (! include.empty() && include.count (t->id) == 0)
                    continue;

                processTrack (*t, n, startMs, msPerSample, nullptr, 0);
                mixTrack (*t, outs, 2, (int) pos, n, master, false);
            }
        }

        const auto peak = mix.getMagnitude (0, mix.getNumSamples());

        MemoryBlock wav;
        {
            std::unique_ptr<OutputStream> stream = std::make_unique<MemoryOutputStream> (wav, false);
            WavAudioFormat format;
            auto writer = format.createWriterFor (stream, AudioFormatWriterOptions{}
                                                              .withSampleRate (sr)
                                                              .withNumChannels (2)
                                                              .withBitsPerSample (32)
                                                              .withSampleFormat (AudioFormatWriterOptions::SampleFormat::floatingPoint));

            if (writer != nullptr)
                writer->writeFromAudioSampleBuffer (mix, 0, mix.getNumSamples());
            else
                error = "Could not create the WAV writer";
        }

        const auto cancelled = cancelRender.load();

        MessageManager::callAsync ([weak, id, peak, sr, totalSamples, done, error, cancelled, wav = std::move (wav)]() mutable
        {
            auto* self = weak.get();

            if (self == nullptr)
                return;

            self->finishRender();

            auto* o = new DynamicObject();

            if (cancelled)
            {
                o->setProperty ("error", "Render cancelled");
            }
            else if (error.isNotEmpty())
            {
                o->setProperty ("error", error);
            }
            else
            {
                while (self->renders.size() >= 3)
                    self->renders.erase (self->renders.begin());

                self->renders[id] = std::move (wav);
                o->setProperty ("id", id);
                o->setProperty ("url", "render/" + id + ".wav");
                o->setProperty ("peak", peak);
                o->setProperty ("seconds", (double) totalSamples / sr);
                o->setProperty ("sampleRate", sr);
            }

            done (var (o));
        });
    });
}

void AudioEngine::finishRender()
{
    if (renderThread.joinable())
        renderThread.join();

    {
        const SpinLock::ScopedLockType sl (transportLock);
        transport = savedTransport;
    }

    for (auto& t : tracks)
    {
        t->pending.clear();
        t->held.fill (false);
    }

    // (adding the callback re-prepares everything for realtime when a device is open)
    if (deviceManager.getCurrentAudioDevice() == nullptr)
        prepareAll (sampleRate, blockSize, false);

    rendering = false;
    deviceManager.addAudioCallback (this);

    // apply what arrived while rendering
    if (! pendingStates.empty())
    {
        auto* o = new DynamicObject();

        for (auto& [key, value] : pendingStates)
        {
            auto* entry = new DynamicObject();
            entry->setProperty ("plugin", value.first);
            entry->setProperty ("state", value.second);
            o->setProperty (key, var (entry));
        }

        pendingStates.clear();
        setState (var (o));
    }

    if (hasDeferred)
    {
        hasDeferred = false;
        syncTracks (deferredSpecs, deferredMaster);
    }
}

const MemoryBlock* AudioEngine::getRender (const String& id) const
{
    const auto it = renders.find (id);
    return it != renders.end() ? &it->second : nullptr;
}
