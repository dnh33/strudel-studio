/*
    Strudel Studio - native app (JUCE)

    Hosts the Strudel Studio web UI in a WebView (WebView2 on Windows) and adds what a browser
    can't do: VST3 instruments and effects, low-latency audio (ASIO / WASAPI / CoreAudio / ALSA / JACK),
    direct MIDI device access and native file dialogs.
*/

#include <JuceHeader.h>
#include "AudioEngine.h"
#include "PluginHost.h"
#include "PluginWindows.h"
#include "StudioWebView.h"

using namespace juce;

//==============================================================================
class MainComponent final : public Component,
                            private Timer
{
public:
    MainComponent()
    {
        engine.initialiseAudio();
        engine.loadSession();

        bridge.showAudioSettings = [this] { showAudioSettings(); };

       #if JUCE_WINDOWS
        if (! WebBrowserComponent::areOptionsSupported (bridge.buildOptions()))
        {
            // Windows without the WebView2 runtime (it ships with Windows 10/11, but can be missing)
            AlertWindow::showAsync (MessageBoxOptions()
                                        .withIconType (MessageBoxIconType::WarningIcon)
                                        .withTitle ("Microsoft Edge WebView2 is missing")
                                        .withMessage ("Strudel Studio shows its studio in a WebView2 browser view, which "
                                                      "isn't installed on this PC.\n\nInstall the free \"WebView2 Runtime\" from "
                                                      "Microsoft (the Evergreen bootstrapper), then start Strudel Studio again.")
                                        .withButton ("Open download page")
                                        .withButton ("Close"),
                                    [] (int result)
                                    {
                                        if (result == 1)
                                            URL ("https://developer.microsoft.com/microsoft-edge/webview2/").launchInDefaultBrowser();
                                    });
        }
       #endif

        web = std::make_unique<StudioWebView> (bridge);
        addAndMakeVisible (*web);
        web->goToURL (bridge.getStartUrl());

        setSize (1440, 900);
        startTimer (120 * 1000);
    }

    ~MainComponent() override
    {
        shutdown();
    }

    void shutdown()
    {
        if (isShutDown)
            return;

        isShutDown = true;
        stopTimer();
        engine.saveSession();
        windows.closeAll();       // editors must be deleted before their plug-ins
        web = nullptr;
        engine.deviceManager.removeAudioCallback (&engine);
    }

    void resized() override
    {
        if (web != nullptr)
            web->setBounds (getLocalBounds());
    }

    void paint (Graphics& g) override
    {
        g.fillAll (Colour (0xff1e2226));
    }

    void showAudioSettings()
    {
        auto* selector = new AudioDeviceSelectorComponent (engine.deviceManager, 0, 0, 2, 2, true, false, true, false);
        selector->setSize (560, 480);

        DialogWindow::LaunchOptions o;
        o.content.setOwned (selector);
        o.dialogTitle = "Audio & MIDI settings";
        o.dialogBackgroundColour = Colour (0xff2b3035);
        o.escapeKeyTriggersCloseButton = true;
        o.useNativeTitleBar = true;
        o.resizable = true;
        o.componentToCentreAround = this;
        o.launchAsync();
    }

    void openPath (const String& path)
    {
        bridge.emit ("ss_openPath", path);
    }

    NativeBridge& getBridge() { return bridge; }

private:
    void timerCallback() override
    {
        if (! engine.isRendering())
            engine.saveSession();
    }

    PluginHost host;
    AudioEngine engine { host };
    PluginWindowManager windows;
    NativeBridge bridge { engine, host, windows };
    std::unique_ptr<StudioWebView> web;
    bool isShutDown = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};

//==============================================================================
class MainWindow final : public DocumentWindow
{
public:
    MainWindow (const String& name, PropertiesFile& props)
        : DocumentWindow (name, Colour (0xff1e2226), DocumentWindow::allButtons),
          settings (props)
    {
        setUsingNativeTitleBar (true);
        content = new MainComponent();
        setContentOwned (content, true);
        setResizable (true, false);
        setResizeLimits (900, 560, 10000, 10000);

        content->getBridge().setWindowTitle = [this] (const String& title)
        {
            setName (title.isNotEmpty() ? title + " - Strudel Studio" : String ("Strudel Studio"));
        };

        content->getBridge().requestQuit = [] { JUCEApplication::getInstance()->systemRequestedQuit(); };

        const auto saved = settings.getValue ("windowState");

        if (saved.isEmpty() || ! restoreWindowStateFromString (saved))
            centreWithSize (1440, 900);

        setVisible (true);
    }

    ~MainWindow() override
    {
        settings.setValue ("windowState", getWindowStateAsString());
        settings.saveIfNeeded();
    }

    void closeButtonPressed() override
    {
        JUCEApplication::getInstance()->systemRequestedQuit();
    }

    void prepareToQuit()
    {
        settings.setValue ("windowState", getWindowStateAsString());
        settings.saveIfNeeded();
        content->shutdown();
    }

    MainComponent* content = nullptr;

private:
    PropertiesFile& settings;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
};

//==============================================================================
class StrudelStudioApplication final : public JUCEApplication
{
public:
    const String getApplicationName() override       { return "Strudel Studio"; }
    const String getApplicationVersion() override    { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override       { return false; }

    void initialise (const String&) override
    {
       #if JUCE_WINDOWS
        // Keep the web audio + Strudel scheduler running at full speed when the window is in the
        // background or covered, and let audio start without an extra click.
        _putenv_s ("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                   "--autoplay-policy=no-user-gesture-required "
                   "--disable-background-timer-throttling "
                   "--disable-renderer-backgrounding "
                   "--disable-backgrounding-occluded-windows");
       #endif

        PropertiesFile::Options po;
        po.applicationName = "settings";
        po.filenameSuffix = ".xml";
        po.storageFormat = PropertiesFile::storeAsXML;
        settings = std::make_unique<PropertiesFile> (PluginHost::getDataFolder().getChildFile ("settings.xml"), po);

        LookAndFeel::setDefaultLookAndFeel (&lookAndFeel);
        mainWindow = std::make_unique<MainWindow> (getApplicationName(), *settings);
    }

    void shutdown() override
    {
        if (mainWindow != nullptr)
            mainWindow->prepareToQuit();

        mainWindow = nullptr;
        settings = nullptr;
        LookAndFeel::setDefaultLookAndFeel (nullptr);
    }

    void systemRequestedQuit() override
    {
        quit();
    }

    void anotherInstanceStarted (const String& commandLine) override
    {
        if (mainWindow == nullptr)
            return;

        mainWindow->setMinimised (false);
        mainWindow->toFront (true);

        const auto args = StringArray::fromTokens (commandLine, true);

        if (! args.isEmpty() && args[0].unquoted().isNotEmpty())
            mainWindow->content->openPath (args[0].unquoted());
    }

private:
    LookAndFeel_V4 lookAndFeel { LookAndFeel_V4::getDarkColourScheme() };
    std::unique_ptr<PropertiesFile> settings;
    std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION (StrudelStudioApplication)
