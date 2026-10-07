#include "PluginWindows.h"

using namespace juce;

class PluginWindowManager::Window final : public DocumentWindow
{
public:
    Window (PluginWindowManager& o, const String& k, AudioPluginInstance& plugin, const String& title, bool generic)
        : DocumentWindow (title, Colour (0xff2b3035), DocumentWindow::minimiseButton | DocumentWindow::closeButton),
          owner (o), key (k)
    {
        AudioProcessorEditor* editor = nullptr;

        if (! generic && plugin.hasEditor())
            editor = plugin.createEditorAndMakeActive();

        if (editor == nullptr)
        {
            auto* g = new GenericAudioProcessorEditor (plugin);
            g->setSize (420, jlimit (120, 640, 40 + 36 * plugin.getParameters().size()));
            editor = g;
        }

        setUsingNativeTitleBar (true);
        setContentOwned (editor, true);
        setResizable (editor->isResizable(), false);
        setAlwaysOnTop (false);
    }

    ~Window() override
    {
        // the editor must go before its plug-in does
        clearContentComponent();
    }

    void closeButtonPressed() override
    {
        // deleting ourselves from inside our own callback isn't safe, so do it asynchronously
        MessageManager::callAsync ([&o = owner, k = key] { o.windowClosed (k); });
    }

private:
    PluginWindowManager& owner;
    String key;
};

PluginWindowManager::PluginWindowManager() = default;

PluginWindowManager::~PluginWindowManager()
{
    onWindowStateChanged = nullptr;
    closeAll();
}

bool PluginWindowManager::open (const String& key, AudioPluginInstance& plugin, const String& title, bool generic)
{
    if (auto it = windows.find (key); it != windows.end())
    {
        it->second->setVisible (true);
        it->second->setMinimised (false);
        it->second->toFront (true);
        return true;
    }

    auto w = std::make_unique<Window> (*this, key, plugin, title, generic);

    if (auto pos = lastPositions.find (key); pos != lastPositions.end())
        w->setTopLeftPosition (pos->second);
    else
        w->centreWithSize (w->getWidth(), w->getHeight());

    w->setVisible (true);
    w->toFront (true);
    windows[key] = std::move (w);

    if (onWindowStateChanged)
        onWindowStateChanged (key, true);

    return true;
}

void PluginWindowManager::windowClosed (const String& key)
{
    close (key);
}

void PluginWindowManager::close (const String& key)
{
    if (auto it = windows.find (key); it != windows.end())
    {
        lastPositions[key] = it->second->getPosition();
        windows.erase (it);

        if (onWindowStateChanged)
            onWindowStateChanged (key, false);
    }
}

void PluginWindowManager::closeAll()
{
    while (! windows.empty())
        close (windows.begin()->first);
}

bool PluginWindowManager::isOpen (const String& key) const
{
    return windows.find (key) != windows.end();
}
