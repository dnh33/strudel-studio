#include "PluginHost.h"

using namespace juce;

File PluginHost::getDataFolder()
{
    auto dir = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("StrudelStudio");
    dir.createDirectory();
    return dir;
}

PluginHost::PluginHost() : Thread ("Plug-in scanner")
{
    addDefaultFormatsToManager (formatManager);

    listFile = getDataFolder().getChildFile ("plugins.xml");
    deadMansPedal = getDataFolder().getChildFile ("plugin-scan-crashed.txt");

    if (auto xml = parseXML (listFile))
        knownList.recreateFromXml (*xml);
}

PluginHost::~PluginHost()
{
    stopThread (10000);
}

void PluginHost::startScan (const StringArray& extraFolders, bool rescanEverything)
{
    if (scanning.exchange (true))
        return;

    foldersToScan = extraFolders;
    rescanAll = rescanEverything;
    lastFailed.clear();
    startThread();
}

void PluginHost::run()
{
    for (auto* format : formatManager.getFormats())
    {
        if (! format->canScanForPlugins())
            continue;

        auto path = format->getDefaultLocationsToSearch();

        // plug-ins that ship with Strudel Studio (VST3 folder next to the program or in a parent folder)
        for (auto dir = File::getSpecialLocation (File::currentExecutableFile).getParentDirectory();
             dir.exists() && dir.getParentDirectory() != dir; dir = dir.getParentDirectory())
        {
            if (dir.getChildFile ("VST3").isDirectory())
            {
                path.add (dir.getChildFile ("VST3"));
                break;
            }
        }

        for (auto& f : foldersToScan)
            if (File::isAbsolutePath (f) && File (f).isDirectory())
                path.add (File (f));

        path.removeRedundantPaths();

        if (rescanAll)
        {
            for (auto& t : knownList.getTypesForFormat (*format))
                knownList.removeType (t);
        }

        PluginDirectoryScanner scanner (knownList, *format, path, true, deadMansPedal, false);
        String name;

        while (! threadShouldExit())
        {
            const auto progress = scanner.getProgress();
            const auto next = scanner.getNextPluginFileThatWillBeScanned();

            MessageManager::callAsync ([this, progress, next]
            {
                if (onScanProgress)
                    onScanProgress (progress, next);
            });

            if (! scanner.scanNextFile (true, name))
                break;
        }

        lastFailed.addArray (scanner.getFailedFiles());
    }

    saveList();
    scanning = false;

    MessageManager::callAsync ([this]
    {
        if (onScanFinished)
            onScanFinished (knownList.getNumTypes(), lastFailed);
    });
}

void PluginHost::saveList()
{
    if (auto xml = knownList.createXml())
        xml->writeTo (listFile);
}

var PluginHost::listAsVar() const
{
    Array<var> result;

    for (const auto& d : knownList.getTypes())
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", d.createIdentifierString());
        o->setProperty ("name", d.name);
        o->setProperty ("vendor", d.manufacturerName);
        o->setProperty ("category", d.category);
        o->setProperty ("format", d.pluginFormatName);
        o->setProperty ("isInstrument", d.isInstrument);
        o->setProperty ("inputs", d.numInputChannels);
        o->setProperty ("outputs", d.numOutputChannels);
        o->setProperty ("version", d.version);
        o->setProperty ("file", d.fileOrIdentifier);
        result.add (var (o));
    }

    return result;
}

std::optional<PluginDescription> PluginHost::findByIdentifier (const String& identifier) const
{
    if (auto d = knownList.getTypeForIdentifierString (identifier))
        return *d;

    return std::nullopt;
}

std::unique_ptr<AudioPluginInstance> PluginHost::createInstance (const String& identifier,
                                                                 double sampleRate,
                                                                 int blockSize,
                                                                 String& error)
{
    const auto desc = findByIdentifier (identifier);

    if (! desc.has_value())
    {
        error = "Plug-in not found (rescan your plug-ins): " + identifier;
        return nullptr;
    }

    auto instance = formatManager.createPluginInstance (*desc, sampleRate, blockSize, error);

    if (instance == nullptr && error.isEmpty())
        error = "Could not load " + desc->name;

    return instance;
}
