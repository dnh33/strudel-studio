#pragma once

#include <JuceHeader.h>
#include "AudioEngine.h"
#include "PluginHost.h"
#include "PluginWindows.h"

/**
    Everything the web UI can ask the native side to do. The functions are registered as JUCE
    WebView "native functions" (all prefixed `ss_`) and events are pushed back with emit().
    See src/native/bridge.ts for the JavaScript side.
*/
class NativeBridge final
{
public:
    NativeBridge (AudioEngine&, PluginHost&, PluginWindowManager&);
    ~NativeBridge();

    juce::WebBrowserComponent::Options buildOptions();

    /** The folder that holds the built web app (index.html). */
    static juce::File findWebRoot();
    juce::String getStartUrl() const;

    void emit (const juce::Identifier& eventId, const juce::var& payload);
    void attach (juce::WebBrowserComponent* w) { browser = w; }

    std::function<void()> showAudioSettings;
    std::function<void (const juce::String&)> setWindowTitle;
    std::function<void()> requestQuit;

    bool isAllowedUrl (const juce::String& url) const;

private:
    using Args = juce::Array<juce::var>;
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;

    std::optional<juce::WebBrowserComponent::Resource> serve (const juce::String& path);
    juce::var hello() const;

    AudioEngine& engine;
    PluginHost& host;
    PluginWindowManager& windows;
    juce::WebBrowserComponent* browser = nullptr;
    juce::File webRoot;
    juce::String devUrl;
    std::unique_ptr<juce::FileChooser> chooser;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NativeBridge)
};

class StudioWebView final : public juce::WebBrowserComponent
{
public:
    explicit StudioWebView (NativeBridge&);
    ~StudioWebView() override;

    bool pageAboutToLoad (const juce::String& newURL) override;
    void newWindowAttemptingToLoad (const juce::String& newURL) override;
    void pageFinishedLoading (const juce::String& url) override;

private:
    NativeBridge& bridge;
    bool testScriptStarted = false;
};
