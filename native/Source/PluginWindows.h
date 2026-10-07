#pragma once

#include <JuceHeader.h>

/** Floating windows that show plug-in editors (the plug-in's own GUI, or a generic
    parameter list for plug-ins without one). One window per track slot. */
class PluginWindowManager final
{
public:
    PluginWindowManager();
    ~PluginWindowManager();

    /** Opens (or brings to front) the editor of a plug-in. `title` is shown in the title bar. */
    bool open (const juce::String& key, juce::AudioPluginInstance& plugin, const juce::String& title, bool generic = false);
    void close (const juce::String& key);
    void closeAll();
    bool isOpen (const juce::String& key) const;

    std::function<void (const juce::String& key, bool isOpen)> onWindowStateChanged;

private:
    class Window;

    void windowClosed (const juce::String& key);

    std::map<juce::String, std::unique_ptr<Window>> windows;
    std::map<juce::String, juce::Point<int>> lastPositions;
};
