# (cross-compiling can't run the VST3 manifest helper; hosts then read the plug-in info from the binary)
if(CMAKE_CROSSCOMPILING)
    set(strudel_vst3_manifest FALSE)
else()
    set(strudel_vst3_manifest TRUE)
endif()

# Two tiny example plug-ins that ship with Strudel Studio: an instrument and an effect.
# They're handy to check that VST3 hosting works, and they are a starting point for your own.

juce_add_plugin(StrudelTestSynth
    PRODUCT_NAME "Strudel Test Synth"
    COMPANY_NAME "Strudel Studio"
    PLUGIN_MANUFACTURER_CODE Stru
    PLUGIN_CODE Tsyn
    BUNDLE_ID "cc.strudel.studio.testsynth"
    FORMATS VST3
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    VST3_CATEGORIES Instrument Synth
    VST3_AUTO_MANIFEST ${strudel_vst3_manifest}
    COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(StrudelTestSynth PRIVATE TestSynth.cpp)
target_compile_definitions(StrudelTestSynth PUBLIC
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
target_link_libraries(StrudelTestSynth
    PRIVATE juce::juce_audio_utils
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

juce_add_plugin(StrudelTestDrive
    PRODUCT_NAME "Strudel Test Drive"
    COMPANY_NAME "Strudel Studio"
    PLUGIN_MANUFACTURER_CODE Stru
    PLUGIN_CODE Tdrv
    BUNDLE_ID "cc.strudel.studio.testdrive"
    FORMATS VST3
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    VST3_CATEGORIES Fx Distortion
    VST3_AUTO_MANIFEST ${strudel_vst3_manifest}
    COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(StrudelTestDrive PRIVATE TestDrive.cpp)
target_compile_definitions(StrudelTestDrive PUBLIC
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
target_link_libraries(StrudelTestDrive
    PRIVATE juce::juce_audio_utils
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
