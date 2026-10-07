// Strudel Test Synth - a small polyphonic VST3 instrument (sine / saw / square + ADSR + low-pass).
// It exists to prove that Strudel Studio's plug-in hosting works and as an example to build on.

#include <juce_audio_utils/juce_audio_utils.h>

using namespace juce;

namespace
{
    struct Sound final : SynthesiserSound
    {
        bool appliesToNote (int) override    { return true; }
        bool appliesToChannel (int) override { return true; }
    };

    struct Params
    {
        std::atomic<float>* wave = nullptr;
        std::atomic<float>* attack = nullptr;
        std::atomic<float>* decay = nullptr;
        std::atomic<float>* sustain = nullptr;
        std::atomic<float>* release = nullptr;
        std::atomic<float>* cutoff = nullptr;
        std::atomic<float>* gain = nullptr;
    };

    class Voice final : public SynthesiserVoice
    {
    public:
        explicit Voice (const Params& p) : params (p) {}

        using SynthesiserVoice::renderNextBlock;

        bool canPlaySound (SynthesiserSound* s) override { return dynamic_cast<Sound*> (s) != nullptr; }

        void startNote (int note, float velocity, SynthesiserSound*, int) override
        {
            frequency = MidiMessage::getMidiNoteInHertz (note);
            level = velocity;
            phase = 0.0;
            filterState = 0.0f;

            ADSR::Parameters ap;
            ap.attack = params.attack->load();
            ap.decay = params.decay->load();
            ap.sustain = params.sustain->load();
            ap.release = params.release->load();
            adsr.setSampleRate (getSampleRate());
            adsr.setParameters (ap);
            adsr.noteOn();
        }

        void stopNote (float, bool allowTailOff) override
        {
            if (allowTailOff)
            {
                adsr.noteOff();
            }
            else
            {
                adsr.reset();
                clearCurrentNote();
            }
        }

        void pitchWheelMoved (int) override {}
        void controllerMoved (int, int) override {}

        void renderNextBlock (AudioBuffer<float>& out, int start, int num) override
        {
            if (! isVoiceActive())
                return;

            const auto sr = getSampleRate();
            const auto inc = frequency / sr;
            const auto wave = (int) params.wave->load();
            const auto gain = params.gain->load();
            const auto cutoff = jlimit (20.0f, 20000.0f, params.cutoff->load());
            const auto coeff = 1.0f - std::exp (-MathConstants<float>::twoPi * cutoff / (float) sr);

            for (int i = 0; i < num; ++i)
            {
                float s;

                switch (wave)
                {
                    case 1:  s = (float) (2.0 * phase - 1.0); break;                 // saw
                    case 2:  s = phase < 0.5 ? 0.7f : -0.7f; break;                  // square
                    default: s = (float) std::sin (phase * MathConstants<double>::twoPi); break;
                }

                phase += inc;
                if (phase >= 1.0) phase -= 1.0;

                filterState += coeff * (s - filterState);
                const auto v = filterState * adsr.getNextSample() * level * gain * 0.3f;

                for (int ch = 0; ch < out.getNumChannels(); ++ch)
                    out.addSample (ch, start + i, v);

                if (! adsr.isActive())
                {
                    clearCurrentNote();
                    break;
                }
            }
        }

    private:
        const Params& params;
        ADSR adsr;
        double frequency = 440.0, phase = 0.0;
        float level = 1.0f, filterState = 0.0f;
    };
}

class TestSynthProcessor final : public AudioProcessor
{
public:
    TestSynthProcessor()
        : AudioProcessor (BusesProperties().withOutput ("Output", AudioChannelSet::stereo(), true)),
          state (*this, nullptr, "TestSynth", createLayout())
    {
        params.wave = state.getRawParameterValue ("wave");
        params.attack = state.getRawParameterValue ("attack");
        params.decay = state.getRawParameterValue ("decay");
        params.sustain = state.getRawParameterValue ("sustain");
        params.release = state.getRawParameterValue ("release");
        params.cutoff = state.getRawParameterValue ("cutoff");
        params.gain = state.getRawParameterValue ("gain");

        for (int i = 0; i < 16; ++i)
            synth.addVoice (new Voice (params));

        synth.addSound (new Sound());
    }

    static AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using P = AudioParameterFloat;
        AudioProcessorValueTreeState::ParameterLayout layout;
        layout.add (std::make_unique<AudioParameterChoice> (ParameterID { "wave", 1 }, "Wave", StringArray { "Sine", "Saw", "Square" }, 1));
        layout.add (std::make_unique<P> (ParameterID { "attack", 1 }, "Attack", NormalisableRange<float> (0.001f, 2.0f, 0.0f, 0.4f), 0.005f));
        layout.add (std::make_unique<P> (ParameterID { "decay", 1 }, "Decay", NormalisableRange<float> (0.001f, 2.0f, 0.0f, 0.4f), 0.2f));
        layout.add (std::make_unique<P> (ParameterID { "sustain", 1 }, "Sustain", NormalisableRange<float> (0.0f, 1.0f), 0.7f));
        layout.add (std::make_unique<P> (ParameterID { "release", 1 }, "Release", NormalisableRange<float> (0.001f, 4.0f, 0.0f, 0.4f), 0.25f));
        layout.add (std::make_unique<P> (ParameterID { "cutoff", 1 }, "Cutoff", NormalisableRange<float> (40.0f, 20000.0f, 0.0f, 0.25f), 6000.0f));
        layout.add (std::make_unique<P> (ParameterID { "gain", 1 }, "Gain", NormalisableRange<float> (0.0f, 2.0f), 1.0f));
        return layout;
    }

    const String getName() const override { return "Strudel Test Synth"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 4.0; }

    bool isBusesLayoutSupported (const BusesLayout& l) const override
    {
        const auto out = l.getMainOutputChannelSet();
        return out == AudioChannelSet::stereo() || out == AudioChannelSet::mono();
    }

    void prepareToPlay (double sr, int) override
    {
        synth.setCurrentPlaybackSampleRate (sr);
    }

    void releaseResources() override {}

    using AudioProcessor::processBlock;

    void processBlock (AudioBuffer<float>& buffer, MidiBuffer& midi) override
    {
        ScopedNoDenormals noDenormals;
        buffer.clear();
        synth.renderNextBlock (buffer, midi, 0, buffer.getNumSamples());
    }

    bool hasEditor() const override { return true; }
    AudioProcessorEditor* createEditor() override { return new GenericAudioProcessorEditor (*this); }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const String&) override {}

    void getStateInformation (MemoryBlock& dest) override
    {
        if (auto xml = state.copyState().createXml())
            copyXmlToBinary (*xml, dest);
    }

    void setStateInformation (const void* data, int size) override
    {
        if (auto xml = getXmlFromBinary (data, size))
            state.replaceState (ValueTree::fromXml (*xml));
    }

private:
    AudioProcessorValueTreeState state;
    Params params;
    Synthesiser synth;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TestSynthProcessor)
};

AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new TestSynthProcessor();
}
