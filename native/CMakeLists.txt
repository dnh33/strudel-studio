cmake_minimum_required(VERSION 3.22)

project(StrudelStudioNative VERSION 1.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set_property(GLOBAL PROPERTY USE_FOLDERS YES)

option(STRUDEL_BUILD_TEST_SYNTH "Also build the example VST3 plug-ins (Strudel Test Synth / Test Drive)" ON)
option(STRUDEL_LTO "Link-time optimisation for the app (slower to link)" ON)

# one self-contained .exe: link the C runtime statically (no VC++ redistributable needed)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# ---------------------------------------------------------------- JUCE
# Use a local checkout with -DJUCE_DIR=/path/to/JUCE, otherwise JUCE 9.0.2 is downloaded.
set(STRUDEL_JUCE_VERSION "9.0.2")
if(JUCE_DIR AND EXISTS "${JUCE_DIR}/CMakeLists.txt")
    message(STATUS "Using JUCE from ${JUCE_DIR}")
    add_subdirectory("${JUCE_DIR}" "${CMAKE_BINARY_DIR}/JUCE" EXCLUDE_FROM_ALL)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE
        URL "https://github.com/juce-framework/JUCE/archive/refs/tags/${STRUDEL_JUCE_VERSION}.zip"
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

# ---------------------------------------------------------------- WebView2 (Windows)
# JUCE links the WebView2 loader statically; it needs the Microsoft.Web.WebView2 NuGet package.
# If it isn't installed in the default NuGet folder we download it next to the build.
if(WIN32)
    set(STRUDEL_WEBVIEW2_VERSION "1.0.3485.44")
    if(NOT JUCE_WEBVIEW2_PACKAGE_LOCATION)
        set(_nuget_dir "${CMAKE_BINARY_DIR}/_deps/nuget")
        set(_pkg_dir "${_nuget_dir}/Microsoft.Web.WebView2.${STRUDEL_WEBVIEW2_VERSION}")
        if(NOT EXISTS "${_pkg_dir}/build/native/include/WebView2.h")
            message(STATUS "Downloading Microsoft.Web.WebView2 ${STRUDEL_WEBVIEW2_VERSION} from nuget.org")
            file(DOWNLOAD
                "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${STRUDEL_WEBVIEW2_VERSION}"
                "${_nuget_dir}/webview2.nupkg"
                EXPECTED_HASH SHA256=bc09150b179246ac90189649b13be8e6b11b3ac200e817e18df106e1f3cf489e
                SHOW_PROGRESS)
            file(ARCHIVE_EXTRACT INPUT "${_nuget_dir}/webview2.nupkg" DESTINATION "${_pkg_dir}")
        endif()
        set(JUCE_WEBVIEW2_PACKAGE_LOCATION "${_nuget_dir}" CACHE PATH "WebView2 NuGet packages folder" FORCE)
    endif()
endif()

# ---------------------------------------------------------------- the app
juce_add_gui_app(StrudelStudio
    PRODUCT_NAME "Strudel Studio"
    COMPANY_NAME "Strudel Studio"
    COMPANY_WEBSITE "https://strudel.cc"
    BUNDLE_ID "cc.strudel.studio"
    VERSION ${PROJECT_VERSION}
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/Resources/icon.png"
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    NEEDS_CURL FALSE
    DOCUMENT_EXTENSIONS json)

juce_generate_juce_header(StrudelStudio)

target_sources(StrudelStudio PRIVATE
    Source/Main.cpp
    Source/StudioWebView.cpp
    Source/AudioEngine.cpp
    Source/PluginHost.cpp
    Source/PluginWindows.cpp)

target_compile_definitions(StrudelStudio PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:StrudelStudio,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:StrudelStudio,JUCE_VERSION>"
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_LV2=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_PLUGINHOST_AU=1
    JUCE_ASIO=1
    JUCE_WASAPI=1
    JUCE_DIRECTSOUND=1
    $<$<PLATFORM_ID:Linux>:JUCE_JACK=1>
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_STRICT_REFCOUNTEDPOINTER=1)

target_link_libraries(StrudelStudio
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_gui_extra
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

if(STRUDEL_LTO)
    target_link_libraries(StrudelStudio PUBLIC juce::juce_recommended_lto_flags)
endif()

if(MSVC)
    target_compile_options(StrudelStudio PRIVATE /bigobj /utf-8)
endif()

# ---------------------------------------------------------------- example / test plug-in
if(STRUDEL_BUILD_TEST_SYNTH)
    add_subdirectory(TestSynth)
endif()
