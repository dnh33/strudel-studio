#pragma once

#include <JuceHeader.h>

/** Knows which plug-ins are installed (VST3, and AU on macOS), scans for them on a
    background thread and creates instances. The list is cached in the app-data folder. */
class PluginHost final : private juce::Thread
{
public:
    PluginHost();
    ~PluginHost() override;

    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownList;

    /** Called on the message thread. */
    std::function<void (float progress, const juce::String& currentFile)> onScanProgress;
    std::function<void (int numPlugins, const juce::StringArray& failed)> onScanFinished;

    void startScan (const juce::StringArray& extraFolders, bool rescanEverything);
    bool isScanning() const noexcept { return scanning.load(); }

    /** All known plug-ins as a JS friendly array. */
    juce::var listAsVar() const;

    std::optional<juce::PluginDescription> findByIdentifier (const juce::String& identifier) const;

    std::unique_ptr<juce::AudioPluginInstance> createInstance (const juce::String& identifier,
                                                               double sampleRate,
                                                               int blockSize,
                                                               juce::String& error);

    static juce::File getDataFolder();

private:
    void run() override;
    void saveList();

    juce::File listFile, deadMansPedal;
    juce::StringArray foldersToScan;
    bool rescanAll = false;
    std::atomic<bool> scanning { false };
    juce::StringArray lastFailed;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginHost)
};
