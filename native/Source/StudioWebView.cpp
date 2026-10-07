#include "StudioWebView.h"
#include <iostream>

using namespace juce;

namespace
{
    String mimeFor (const String& path)
    {
        static const std::map<String, String> types {
            { "html", "text/html; charset=utf-8" }, { "htm", "text/html; charset=utf-8" },
            { "js", "text/javascript; charset=utf-8" }, { "mjs", "text/javascript; charset=utf-8" },
            { "css", "text/css; charset=utf-8" }, { "json", "application/json" }, { "map", "application/json" },
            { "wasm", "application/wasm" }, { "svg", "image/svg+xml" }, { "png", "image/png" },
            { "jpg", "image/jpeg" }, { "jpeg", "image/jpeg" }, { "gif", "image/gif" }, { "webp", "image/webp" },
            { "ico", "image/x-icon" }, { "woff", "font/woff" }, { "woff2", "font/woff2" }, { "ttf", "font/ttf" },
            { "otf", "font/otf" }, { "wav", "audio/wav" }, { "mp3", "audio/mpeg" }, { "ogg", "audio/ogg" },
            { "flac", "audio/flac" }, { "txt", "text/plain; charset=utf-8" }, { "md", "text/plain; charset=utf-8" },
            { "sf2", "application/octet-stream" }
        };

        const auto ext = path.fromLastOccurrenceOf (".", false, false).toLowerCase();
        const auto it = types.find (ext);
        return it != types.end() ? it->second : String ("application/octet-stream");
    }

    WebBrowserComponent::Resource makeResource (const void* data, size_t size, const String& mime)
    {
        WebBrowserComponent::Resource r;
        r.data.resize (size);

        if (size > 0)
            std::memcpy (r.data.data(), data, size);

        r.mimeType = mime;
        return r;
    }

    String originOf (const String& url)
    {
        const auto scheme = url.upToFirstOccurrenceOf ("://", true, false);
        const auto rest = url.fromFirstOccurrenceOf ("://", false, false);
        return scheme + rest.upToFirstOccurrenceOf ("/", false, false);
    }

    var result (std::initializer_list<std::pair<const char*, var>> props)
    {
        auto* o = new DynamicObject();

        for (auto& [k, v] : props)
            o->setProperty (k, v);

        return var (o);
    }

    const char* missingWebAppPage = R"(<!doctype html><html><head><meta charset="utf-8"><title>Strudel Studio</title>
<style>body{background:#1e2226;color:#dde;font:15px system-ui;padding:40px;line-height:1.5}code{background:#333;padding:2px 6px;border-radius:4px}</style>
</head><body><h2>The web app wasn't found</h2>
<p>Strudel Studio's native app shows the same studio as the web version. It looks for <code>app/index.html</code>
next to the program (or in a parent folder).</p>
<p>Build it once with <code>npm install</code> and <code>npm run build</code> in the project folder
(the <b>Build Native App.bat</b> script does this for you), then start Strudel Studio again.</p></body></html>)";
}

//==============================================================================
NativeBridge::NativeBridge (AudioEngine& e, PluginHost& h, PluginWindowManager& w)
    : engine (e), host (h), windows (w)
{
    webRoot = findWebRoot();
    devUrl = SystemStats::getEnvironmentVariable ("STRUDEL_STUDIO_DEV_URL", {});

    engine.onStatusChanged = [this] (const var& v) { emit ("ss_status", v); };
    engine.onMeters        = [this] (const var& v) { emit ("ss_meters", v); };
    engine.onMidiIn        = [this] (const var& v) { emit ("ss_midi", v); };
    engine.onAudioChanged  = [this] (const var& v) { emit ("ss_audio", v); };
    engine.onPluginRemoved = [this] (const String& track, const String& slot) { windows.close (track + "|" + slot); };

    host.onScanProgress = [this] (float progress, const String& file)
    {
        emit ("ss_scanProgress", result ({ { "progress", progress }, { "file", file } }));
    };

    host.onScanFinished = [this] (int count, const StringArray& failed)
    {
        Array<var> f;
        for (auto& s : failed)
            f.add (s);

        emit ("ss_scanFinished", result ({ { "count", count }, { "failed", f }, { "plugins", host.listAsVar() } }));
    };

    windows.onWindowStateChanged = [this] (const String& key, bool open)
    {
        emit ("ss_editor", result ({ { "track", key.upToFirstOccurrenceOf ("|", false, false) },
                                     { "slot", key.fromFirstOccurrenceOf ("|", false, false) },
                                     { "open", open } }));
    };
}

NativeBridge::~NativeBridge()
{
    engine.onStatusChanged = nullptr;
    engine.onMeters = nullptr;
    engine.onMidiIn = nullptr;
    engine.onAudioChanged = nullptr;
    engine.onPluginRemoved = nullptr;
    host.onScanProgress = nullptr;
    host.onScanFinished = nullptr;
    windows.onWindowStateChanged = nullptr;
}

File NativeBridge::findWebRoot()
{
    const auto env = SystemStats::getEnvironmentVariable ("STRUDEL_STUDIO_WEB_ROOT", {});

    if (env.isNotEmpty() && File::isAbsolutePath (env) && File (env).getChildFile ("index.html").existsAsFile())
        return File (env);

    auto dir = File::getSpecialLocation (File::currentExecutableFile).getParentDirectory();

    for (int i = 0; i < 8 && dir.exists(); ++i)
    {
        if (dir.getChildFile ("app").getChildFile ("index.html").existsAsFile())
            return dir.getChildFile ("app");

        if (dir.getParentDirectory() == dir)
            break;

        dir = dir.getParentDirectory();
    }

    return {};
}

String NativeBridge::getStartUrl() const
{
    if (devUrl.isNotEmpty())
        return devUrl;

    return WebBrowserComponent::getResourceProviderRoot();
}

bool NativeBridge::isAllowedUrl (const String& url) const
{
    if (url.startsWith (WebBrowserComponent::getResourceProviderRoot())
        || url.startsWith ("about:") || url.startsWith ("data:") || url.startsWith ("blob:"))
        return true;

    return devUrl.isNotEmpty() && url.startsWith (originOf (devUrl));
}

void NativeBridge::emit (const Identifier& eventId, const var& payload)
{
    if (browser != nullptr)
        browser->emitEventIfBrowserIsVisible (eventId, payload);
}

var NativeBridge::hello() const
{
    return result ({
        { "app", "Strudel Studio" },
        { "version", JUCE_APPLICATION_VERSION_STRING },
        { "juce", SystemStats::getJUCEVersion() },
        { "os", SystemStats::getOperatingSystemName() },
        { "platform", SystemStats::getOperatingSystemType() & SystemStats::Windows ? "windows"
                    : SystemStats::getOperatingSystemType() & SystemStats::MacOSX ? "mac" : "linux" },
        { "dataFolder", PluginHost::getDataFolder().getFullPathName() },
        { "webRoot", webRoot.getFullPathName() },
        { "resourceRoot", WebBrowserComponent::getResourceProviderRoot() },
        { "clock", AudioEngine::clockMs() },
        { "audio", engine.getAudioInfo() },
        { "syncOffsetMs", engine.getSyncOffsetMs() },
        { "pluginCount", host.knownList.getNumTypes() },
        { "scanning", host.isScanning() },
        { "defaultPluginFolders", [this]
            {
                Array<var> folders;

                for (auto* f : host.formatManager.getFormats())
                    for (int i = 0; i < f->getDefaultLocationsToSearch().getNumPaths(); ++i)
                        folders.add (f->getDefaultLocationsToSearch()[i].getFullPathName());

                return var (folders);
            }() },
        { "openPath", JUCEApplication::getCommandLineParameterArray().isEmpty() ? String()
                          : JUCEApplication::getCommandLineParameterArray()[0].unquoted() }
    });
}

std::optional<WebBrowserComponent::Resource> NativeBridge::serve (const String& requestPath)
{
    auto path = URL::removeEscapeChars (requestPath.upToFirstOccurrenceOf ("?", false, false)
                                                   .upToFirstOccurrenceOf ("#", false, false));

    if (path.isEmpty() || path == "/")
        path = "/index.html";

    // rendered audio of the plug-in tracks
    if (path.startsWith ("/render/"))
    {
        const auto id = path.fromFirstOccurrenceOf ("/render/", false, false).upToFirstOccurrenceOf (".", false, false);

        if (auto* mb = engine.getRender (id))
            return makeResource (mb->getData(), mb->getSize(), "audio/wav");

        return std::nullopt;
    }

    if (webRoot == File())
    {
        if (path == "/index.html")
            return makeResource (missingWebAppPage, std::strlen (missingWebAppPage), "text/html; charset=utf-8");

        return std::nullopt;
    }

    if (path.contains ("..") || path.contains ("\\") || path.contains (":"))
        return std::nullopt;

    const auto file = webRoot.getChildFile (path.substring (1));

    if (! file.isAChildOf (webRoot) || ! file.existsAsFile())
        return std::nullopt;

    MemoryBlock mb;

    if (! file.loadFileAsData (mb))
        return std::nullopt;

    return makeResource (mb.getData(), mb.getSize(), mimeFor (file.getFileName()));
}

//==============================================================================
static File webViewDataFolder()
{
   #if JUCE_WINDOWS
    // the browser profile (autosave, caches) is machine-local: %LOCALAPPDATA%\StrudelStudio\WebView2
    return File::getSpecialLocation (File::windowsLocalAppData).getChildFile ("StrudelStudio").getChildFile ("WebView2");
   #else
    return PluginHost::getDataFolder().getChildFile ("WebView2");
   #endif
}

WebBrowserComponent::Options NativeBridge::buildOptions()
{
    using Options = WebBrowserComponent::Options;

    const auto initScript = "window.__STRUDEL_STUDIO_NATIVE__ = " + JSON::toString (result ({
        { "version", JUCE_APPLICATION_VERSION_STRING },
        { "resourceRoot", WebBrowserComponent::getResourceProviderRoot() } }), true) + ";";

    auto options = Options{}
        .withBackend (Options::Backend::webview2)
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withNativeIntegrationEnabled()
        .withUserScript (initScript)
        .withWinWebView2Options (Options::WinWebView2{}
                                     .withUserDataFolder (webViewDataFolder())
                                     .withStatusBarDisabled()
                                     .withBackgroundColour (Colour (0xff1e2226)))
        .withResourceProvider ([this] (const String& p) { return serve (p); },
                               devUrl.isNotEmpty() ? std::optional<String> (originOf (devUrl)) : std::nullopt);

    auto fn = [&options] (const char* name, WebBrowserComponent::NativeFunction f)
    {
        options = options.withNativeFunction (name, std::move (f));
    };

    //------------------------------------------------------------------ basics
    fn ("ss_hello", [this] (const Args&, Completion done) { done (hello()); });

    fn ("ss_clock", [] (const Args&, Completion done) { done (AudioEngine::clockMs()); });

    fn ("ss_audioInfo", [this] (const Args&, Completion done) { done (engine.getAudioInfo()); });

    fn ("ss_audioSettings", [this] (const Args&, Completion done)
    {
        if (showAudioSettings)
            showAudioSettings();

        done (true);
    });

    fn ("ss_setSyncOffset", [this] (const Args& a, Completion done)
    {
        engine.setSyncOffsetMs (jlimit (-500.0, 500.0, (double) a[0]));
        done (engine.getSyncOffsetMs());
    });

    //------------------------------------------------------------------ plug-ins
    fn ("ss_listPlugins", [this] (const Args&, Completion done) { done (host.listAsVar()); });

    fn ("ss_scanPlugins", [this] (const Args& a, Completion done)
    {
        StringArray folders;

        if (auto* arr = a[0].getArray())
            for (auto& f : *arr)
                folders.add (f.toString());

        const auto wasScanning = host.isScanning();
        host.startScan (folders, (bool) a[1]);
        done (! wasScanning);
    });

    fn ("ss_syncTracks", [this] (const Args& a, Completion done)
    {
        engine.syncTracks (AudioEngine::parseTracks (a[0]), a.size() > 1 ? (float) (double) a[1] : 1.0f);
        done (engine.getTrackStatus());
    });

    fn ("ss_trackStatus", [this] (const Args&, Completion done) { done (engine.getTrackStatus()); });

    fn ("ss_openEditor", [this] (const Args& a, Completion done)
    {
        const auto track = a[0].toString(), slot = a[1].toString();

        if (auto* p = engine.findPlugin (track, slot))
        {
            const auto title = a[2].toString().isNotEmpty() ? a[2].toString() : p->getName();
            done (windows.open (track + "|" + slot, *p, title, (bool) a[3]));
            return;
        }

        done (false);
    });

    fn ("ss_closeEditor", [this] (const Args& a, Completion done)
    {
        windows.close (a[0].toString() + "|" + a[1].toString());
        done (true);
    });

    fn ("ss_getState", [this] (const Args&, Completion done) { done (engine.getState()); });

    fn ("ss_setState", [this] (const Args& a, Completion done)
    {
        engine.setState (a[0]);
        done (true);
    });

    fn ("ss_saveSession", [this] (const Args&, Completion done)
    {
        engine.saveSession();
        done (true);
    });

    //------------------------------------------------------------------ playing
    fn ("ss_notes", [this] (const Args& a, Completion done) { done (engine.scheduleNotes (a[0])); });

    fn ("ss_transport", [this] (const Args& a, Completion done)
    {
        const auto& t = a[0];
        engine.setTransport ((bool) t["playing"], (double) t["bpm"], (int) t["beatsPerBar"], (double) t["bar"], (double) t["at"]);
        done (true);
    });

    fn ("ss_panic", [this] (const Args&, Completion done)
    {
        engine.panic();
        done (true);
    });

    fn ("ss_liveNote", [this] (const Args& a, Completion done)
    {
        engine.playLiveNote (a[0].toString(), (int) a[1], (float) (double) a[2], (bool) a[3]);
        done (true);
    });

    fn ("ss_selectTrack", [this] (const Args& a, Completion done)
    {
        engine.setSelectedTrack (a[0].toString());
        done (true);
    });

    //------------------------------------------------------------------ rendering
    fn ("ss_render", [this] (const Args& a, Completion done)
    {
        engine.renderOffline (a[0], [done] (var r) { done (r); });
    });

    fn ("ss_readRender", [this] (const Args& a, Completion done)
    {
        auto* mb = engine.getRender (a[0].toString());

        if (mb == nullptr)
        {
            done (var());
            return;
        }

        const auto offset = jlimit ((int64) 0, (int64) mb->getSize(), (int64) a[1]);
        const auto length = jlimit ((int64) 0, (int64) mb->getSize() - offset, (int64) a[2]);
        done (Base64::toBase64 (static_cast<const char*> (mb->getData()) + offset, (size_t) length));
    });

    fn ("ss_renderSize", [this] (const Args& a, Completion done)
    {
        auto* mb = engine.getRender (a[0].toString());
        done (mb != nullptr ? var ((int64) mb->getSize()) : var (-1));
    });

    //------------------------------------------------------------------ files
    fn ("ss_chooseFile", [this] (const Args& a, Completion done)
    {
        const auto& o = a[0];
        const auto save = o["mode"].toString() == "save";
        const auto folder = o["folder"].toString();
        auto start = File::getSpecialLocation (File::userDocumentsDirectory);

        if (File::isAbsolutePath (folder) && File (folder).isDirectory())
            start = File (folder);

        if (o["name"].toString().isNotEmpty())
            start = start.getChildFile (File::createLegalFileName (o["name"].toString()));

        chooser = std::make_unique<FileChooser> (o["title"].toString().isNotEmpty() ? o["title"].toString() : String ("Choose a file"),
                                                 start,
                                                 o["filters"].toString().isNotEmpty() ? o["filters"].toString() : String ("*"),
                                                 true);

        const auto flags = save ? FileBrowserComponent::saveMode | FileBrowserComponent::canSelectFiles | FileBrowserComponent::warnAboutOverwriting
                                : FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles;

        chooser->launchAsync (flags, [done] (const FileChooser& fc)
        {
            const auto file = fc.getResult();
            done (file == File() ? String() : file.getFullPathName());
        });
    });

    fn ("ss_readFile", [] (const Args& a, Completion done)
    {
        const File file (a[0].toString());

        if (! File::isAbsolutePath (a[0].toString()) || ! file.existsAsFile())
        {
            done (var());
            return;
        }

        if ((bool) a[1])
        {
            MemoryBlock mb;
            file.loadFileAsData (mb);
            done (Base64::toBase64 (mb.getData(), mb.getSize()));
        }
        else
        {
            done (file.loadFileAsString());
        }
    });

    fn ("ss_writeFile", [] (const Args& a, Completion done)
    {
        const auto path = a[0].toString();

        if (! File::isAbsolutePath (path))
        {
            done (false);
            return;
        }

        const File file (path);
        const auto isBase64 = (bool) a[2];
        const auto append = (bool) a[3];

        if (! append)
            file.deleteFile();

        file.getParentDirectory().createDirectory();
        FileOutputStream out (file);

        if (! out.openedOk())
        {
            done (false);
            return;
        }

        if (isBase64)
        {
            MemoryOutputStream decoded;
            Base64::convertFromBase64 (decoded, a[1].toString());
            out.write (decoded.getData(), decoded.getDataSize());
        }
        else
        {
            out.writeText (a[1].toString(), false, false, nullptr);
        }

        out.flush();
        done (! out.getStatus().failed());
    });

    fn ("ss_fileInfo", [] (const Args& a, Completion done)
    {
        const File file (a[0].toString());
        const auto ok = File::isAbsolutePath (a[0].toString()) && file.existsAsFile();
        done (result ({ { "exists", ok },
                        { "name", file.getFileName() },
                        { "size", ok ? (int64) file.getSize() : (int64) 0 },
                        { "modified", ok ? (double) file.getLastModificationTime().toMilliseconds() : 0.0 } }));
    });

    fn ("ss_showInFolder", [] (const Args& a, Completion done)
    {
        const File file (a[0].toString());

        if (File::isAbsolutePath (a[0].toString()) && file.exists())
            file.revealToUser();

        done (true);
    });

    fn ("ss_openUrl", [] (const Args& a, Completion done)
    {
        const auto url = a[0].toString();

        if (url.startsWith ("https://") || url.startsWith ("http://"))
            URL (url).launchInDefaultBrowser();

        done (true);
    });

    fn ("ss_setTitle", [this] (const Args& a, Completion done)
    {
        if (setWindowTitle)
            setWindowTitle (a[0].toString());

        done (true);
    });

    // automated tests (STRUDEL_STUDIO_TEST_SCRIPT=/path/to/test.js runs a script in the page after it loads)
    if (SystemStats::getEnvironmentVariable ("STRUDEL_STUDIO_TEST_SCRIPT", {}).isNotEmpty())
    {
        fn ("ss_testLog", [] (const Args& a, Completion done)
        {
            std::cout << "[test] " << a[0].toString() << std::endl;
            done (true);
        });

        fn ("ss_testExit", [] (const Args& a, Completion done)
        {
            done (true);
            const auto code = (int) a[0];
            std::cout << "[test] exit " << code << std::endl;
            MessageManager::callAsync ([code]
            {
                JUCEApplicationBase::getInstance()->setApplicationReturnValue (code);
                JUCEApplicationBase::getInstance()->systemRequestedQuit();
            });
        });

        fn ("ss_testScreenshot", [this] (const Args& a, Completion done)
        {
            // snapshot of the plug-in editor windows (the WebView itself is captured from outside)
            ignoreUnused (a);
            done (windows.isOpen (a[0].toString()));
        });
    }

    fn ("ss_quit", [this] (const Args&, Completion done)
    {
        done (true);

        if (requestQuit)
            MessageManager::callAsync ([this] { requestQuit(); });
    });

    return options;
}

//==============================================================================
StudioWebView::StudioWebView (NativeBridge& b)
    : WebBrowserComponent (b.buildOptions()), bridge (b)
{
    bridge.attach (this);
}

StudioWebView::~StudioWebView()
{
    bridge.attach (nullptr);
}

bool StudioWebView::pageAboutToLoad (const String& url)
{
    if (bridge.isAllowedUrl (url))
        return true;

    if (url.startsWith ("http://") || url.startsWith ("https://"))
        URL (url).launchInDefaultBrowser();

    return false;
}

void StudioWebView::newWindowAttemptingToLoad (const String& url)
{
    if (url.startsWith ("http://") || url.startsWith ("https://"))
        URL (url).launchInDefaultBrowser();
}

void StudioWebView::pageFinishedLoading (const String& url)
{
    const auto script = SystemStats::getEnvironmentVariable ("STRUDEL_STUDIO_TEST_SCRIPT", {});

    if (script.isNotEmpty() && ! testScriptStarted && ! url.startsWith ("about:"))
    {
        testScriptStarted = true;
        const auto code = File (script).loadFileAsString();
        std::cout << "[test] page loaded: " << url << ", running " << script << std::endl;
        evaluateJavascript (code, [] (EvaluationResult r)
        {
            if (auto* err = r.getError())
                std::cout << "[test] script error: " << err->message << std::endl;
        });
    }
}
