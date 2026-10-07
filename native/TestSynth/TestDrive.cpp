// Strudel Test Drive - a tiny VST3 effect (tanh drive + tone + mix). Example / test plug-in.

#include <juce_audio_utils/juce_audio_utils.h>

using namespace juce;

class TestDriveProcessor final : public AudioProcessor
{
public:
    TestDriveProcessor()
        : AudioProcessor (BusesProperties().withInput ("Input", AudioChannelSet::stereo(), true)
                                           .withOutput ("Output", AudioChannelSet::stereo(), true)),
          state (*this, nullptr, "TestDrive", createLayout())
    {
        drive = state.getRawParameterValue ("drive");
        tone = state.getRawParameterValue ("tone");
        mix = state.getRawParameterValue ("mix");
        output = state.getRawParameterValue ("output");
    }

    static AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using P = AudioParameterFloat;
        AudioProcessorValueTreeState::ParameterLayout layout;
        layout.add (std::make_unique<P> (ParameterID { "drive", 1 }, "Drive", NormalisableRange<float> (1.0f, 40.0f, 0.0f, 0.4f), 6.0f));
        layout.add (std::make_unique<P> (ParameterID { "tone", 1 }, "Tone", NormalisableRange<float> (200.0f, 20000.0f, 0.0f, 0.25f), 8000.0f));
        layout.add (std::make_unique<P> (ParameterID { "mix", 1 }, "Mix", NormalisableRange<float> (0.0f, 1.0f), 1.0f));
        layout.add (std::make_unique<P> (ParameterID { "output", 1 }, "Output", NormalisableRange<float> (0.0f, 2.0f), 0.6f));
        return layout;
    }

    const String getName() const override { return "Strudel Test Drive"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    bool isBusesLayoutSupported (const BusesLayout& l) const override
    {
        return l.getMainOutputChannelSet() == l.getMainInputChannelSet()
            && (l.getMainOutputChannelSet() == AudioChannelSet::stereo() || l.getMainOutputChannelSet() == AudioChannelSet::mono());
    }

    void prepareToPlay (double sr, int) override
    {
        sampleRate = sr;
        std::fill (std::begin (lp), std::end (lp), 0.0f);
    }

    void releaseResources() override {}

    using AudioProcessor::processBlock;

    void processBlock (AudioBuffer<float>& buffer, MidiBuffer&) override
    {
        ScopedNoDenormals noDenormals;
        const auto d = drive->load(), m = mix->load(), g = output->load();
        const auto coeff = 1.0f - std::exp (-MathConstants<float>::twoPi * tone->load() / (float) sampleRate);
        const auto norm = 1.0f / std::tanh (d);

        for (int ch = 0; ch < jmin (2, buffer.getNumChannels()); ++ch)
        {
            auto* x = buffer.getWritePointer (ch);

            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                const auto wet = std::tanh (x[i] * d) * norm;
                lp[ch] += coeff * (wet - lp[ch]);
                x[i] = (x[i] * (1.0f - m) + lp[ch] * m) * g;
            }
        }
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
    std::atomic<float>* drive = nullptr;
    std::atomic<float>* tone = nullptr;
    std::atomic<float>* mix = nullptr;
    std::atomic<float>* output = nullptr;
    double sampleRate = 48000.0;
    float lp[2] {};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TestDriveProcessor)
};

AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new TestDriveProcessor();
}
