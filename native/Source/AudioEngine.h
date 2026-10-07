#pragma once

#include <JuceHeader.h>
#include <bitset>
#include <thread>
#include "PluginHost.h"

/**
    The native half of Strudel Studio.

    Strudel (running in the WebView) keeps doing all the sequencing. Channels that use a VST3
    instrument are compiled to `.s("native").vst(id)`; their notes are sent here with a
    timestamp (in this process' high-resolution millisecond clock, "heard" time), and this
    engine plays them sample-accurately through hosted plug-in chains:

        notes -> instrument plug-in -> effect plug-ins -> volume/pan -> master -> audio device
*/
class AudioEngine final : public juce::AudioIODeviceCallback,
                          public juce::AudioPlayHead,
                          private juce::MidiInputCallback,
                          private juce::Timer,
                          private juce::ChangeListener
{
public:
    explicit AudioEngine (PluginHost&);
    ~AudioEngine() override;

    juce::AudioDeviceManager deviceManager;

    void initialiseAudio();
    void saveDeviceSettings();
    juce::var getAudioInfo() const;

    //==============================================================================
    struct FxSpec
    {
        juce::String slotId, pluginId;
        bool bypass = false;
    };

    struct TrackSpec
    {
        juce::String id, instrumentId;
        std::vector<FxSpec> fx;
        float volume = 0.8f;   // linear gain
        float pan = 0.0f;      // -1..1 (same law as WebAudio's StereoPannerNode)
        bool mute = false;
    };

    static std::vector<TrackSpec> parseTracks (const juce::var& tracksVar);

    /** Creates / removes / reloads tracks and plug-ins to match the web project. Message thread. */
    void syncTracks (const std::vector<TrackSpec>& specs, float masterVolume);

    /** Array of { t: trackId, n: midiNote, v: velocity 0..1, at: heard time (ms, native clock), d: duration ms }. */
    int scheduleNotes (const juce::var& events);

    void setTransport (bool playing, double bpm, int beatsPerBar, double bar, double atMs);
    void panic();
    void setSelectedTrack (const juce::String& trackId);
    void setSyncOffsetMs (double ms) { syncOffsetMs = ms; }
    double getSyncOffsetMs() const { return syncOffsetMs.load(); }

    /** Plays a note right now on a track (on-screen keyboard / piano roll preview). */
    void playLiveNote (const juce::String& trackId, int note, float velocity, bool isOn);

    /** Plug-in states (base64) keyed by "trackId|slotId". */
    juce::var getState();
    void setState (const juce::var& state);
    void saveSession();
    void loadSession();

    juce::var getTrackStatus() const;
    juce::AudioPluginInstance* findPlugin (const juce::String& trackId, const juce::String& slotId) const;
    juce::String describeSlot (const juce::String& trackId, const juce::String& slotId) const;

    /** Offline render of note events through the plug-in chains. `done` is called on the message thread
        with { id, url, peak, seconds, sampleRate } or { error }. */
    void renderOffline (const juce::var& request, std::function<void (juce::var)> done);
    const juce::MemoryBlock* getRender (const juce::String& id) const;
    bool isRendering() const noexcept { return rendering.load(); }

    static double clockMs() { return juce::Time::getMillisecondCounterHiRes(); }

    std::function<void (const juce::var&)> onStatusChanged, onMeters, onMidiIn, onAudioChanged;
    /** Called just before a plug-in instance is deleted (close its editor!). */
    std::function<void (const juce::String& trackId, const juce::String& slotId)> onPluginRemoved;

    //==============================================================================
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                           float* const* outputChannelData, int numOutputChannels,
                                           int numSamples, const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;

    juce::Optional<juce::AudioPlayHead::PositionInfo> getPosition() const override;

private:
    struct Slot
    {
        juce::String slotId, pluginId, name, error;
        std::unique_ptr<juce::AudioPluginInstance> plugin;
        std::atomic<bool> bypass { false };
    };

    struct PendingNote
    {
        double timeMs = 0;     // heard time (realtime) or ms since render start (offline)
        double offTimeMs = 0;  // for note-ons: when the matching note-off is due
        int note = 60;
        float velocity = 1.0f;
        bool isOn = true;
        juce::uint32 gen = 0;  // which note-on a note-off belongs to
    };

    struct Track
    {
        juce::String id;
        int slotIndex = -1;
        std::unique_ptr<Slot> instrument;
        std::vector<std::unique_ptr<Slot>> fx;
        std::atomic<float> volume { 0.8f }, pan { 0.0f };
        std::atomic<bool> mute { false };
        std::vector<PendingNote> pending;
        std::array<bool, 128> held {};
        std::array<juce::uint32, 128> gen {};
        bool killNotes = false;
        juce::AudioBuffer<float> buffer;
        juce::MidiBuffer midi;
        std::atomic<float> peakL { 0.0f }, peakR { 0.0f };
    };

    struct NoteEvent
    {
        enum Type { scheduled, panic, liveOn, liveOff };
        Type type = scheduled;
        int trackSlot = -1;
        int note = 60;
        float velocity = 1.0f;
        double onMs = 0, offMs = 0;
    };

    struct TransportState
    {
        bool playing = false;
        double bpm = 120.0;
        int beatsPerBar = 4;
        double bar = 0.0;
        double atMs = 0.0;
    };

    void handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage&) override;
    void timerCallback() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    void enableAllMidiInputs();
    std::unique_ptr<Slot> createSlot (const juce::String& trackId, const juce::String& slotId, const juce::String& pluginId);
    void prepareSlot (Slot&, double sr, int bs, bool nonRealtime);
    void prepareAll (double sr, int bs, bool nonRealtime);
    static int channelsNeeded (const Track&);
    void allocateBuffers (Track&, int bs);
    void drainFifo();
    void pushEvent (const NoteEvent&);
    void processTrack (Track&, int numSamples, double blockStartMs, double msPerSample,
                       const juce::MidiBuffer* live, int liveStart);
    void runChain (Track&, int numSamples);
    void mixTrack (Track&, float* const* out, int numOut, int offset, int numSamples, float master, bool updateMeters = true);
    void notifyStatus();
    Track* findTrack (const juce::String& id) const;
    int allocateSlotIndex();
    void finishRender();
    static juce::String stateKey (const juce::String& trackId, const juce::String& slotId) { return trackId + "|" + slotId; }

    PluginHost& host;

    juce::CriticalSection trackLock;               // guards the structure of `tracks` (audio thread uses a try-lock)
    std::vector<std::unique_ptr<Track>> tracks;
    std::array<Track*, 512> slotMap {};
    std::bitset<512> slotUsed;                     // message thread only
    int nextSlotIndex = 0;

    juce::AbstractFifo fifo { 8192 };
    std::vector<NoteEvent> fifoData = std::vector<NoteEvent> (8192);
    juce::CriticalSection fifoWriteLock;           // producers: message thread + MIDI thread

    mutable juce::SpinLock transportLock;
    TransportState transport;

    juce::MidiMessageCollector liveMidi;
    juce::MidiBuffer liveBuffer;
    std::atomic<int> selectedSlot { -1 };
    juce::MidiDeviceListConnection midiDevicesConnection;

    std::atomic<float> masterVolume { 1.0f };
    std::atomic<float> masterPeakL { 0.0f }, masterPeakR { 0.0f };

    double sampleRate = 48000.0;
    int blockSize = 512;
    double outputLatencyMs = 20.0;
    std::atomic<double> syncOffsetMs { 0.0 };
    double lastBlockStartMs = 0.0, lastBlockLenMs = 0.0;
    double currentBlockMs = 0.0;                   // heard time of the block being processed (for the play head)
    std::atomic<bool> rendering { false };
    std::atomic<bool> audioRunning { false };
    std::atomic<bool> cancelRender { false };
    std::thread renderThread;
    TransportState savedTransport;

    // plug-in states waiting for their instance (key = trackId|slotId -> { pluginId, base64 state })
    std::map<juce::String, std::pair<juce::String, juce::String>> pendingStates;

    std::map<juce::String, juce::MemoryBlock> renders;
    int renderCounter = 0;

    std::vector<TrackSpec> deferredSpecs;
    float deferredMaster = 1.0f;
    bool hasDeferred = false;
    bool metersWereSilent = false;

    // timing statistics of scheduled (realtime) notes: how many arrived too late to be placed exactly
    std::atomic<int> statNotes { 0 }, statLate { 0 };
    std::atomic<float> statMaxLateMs { 0.0f }, statMinLeadMs { 1.0e9f };

    JUCE_DECLARE_WEAK_REFERENCEABLE (AudioEngine)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
