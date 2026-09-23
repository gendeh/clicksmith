cmake_minimum_required(VERSION 3.21)

if(APPLE AND CMAKE_OSX_SYSROOT AND NOT EXISTS "${CMAKE_OSX_SYSROOT}")
  execute_process(
    COMMAND xcrun --sdk macosx --show-sdk-path
    OUTPUT_VARIABLE CLICKSMITH_MACOS_SDK
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )
  if(CLICKSMITH_MACOS_SDK AND EXISTS "${CLICKSMITH_MACOS_SDK}")
    set(CMAKE_OSX_SYSROOT "${CLICKSMITH_MACOS_SDK}" CACHE PATH "macOS SDK path" FORCE)
  else()
    unset(CMAKE_OSX_SYSROOT CACHE)
  endif()
endif()

project(clicksmith_geode_adapter VERSION 0.2.7)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
option(CLICKSMITH_GEODE_ENABLE_CLI "Run Geode CLI project checks and packaging" OFF)
if(NOT CLICKSMITH_GEODE_ENABLE_CLI)
  set(GEODE_DISABLE_CLI_CALLS ON CACHE BOOL "Disable Geode CLI calls for sandboxed/CI builds" FORCE)
endif()

if(APPLE)
  if("${CMAKE_OSX_ARCHITECTURES}" STREQUAL "" AND CMAKE_HOST_SYSTEM_PROCESSOR MATCHES "arm64")
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Target architectures for macOS builds" FORCE)
  endif()
  if("${CMAKE_OSX_DEPLOYMENT_TARGET}" STREQUAL "")
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS deployment target" FORCE)
  endif()
endif()

if(NOT DEFINED ENV{GEODE_SDK})
  message(FATAL_ERROR "GEODE_SDK is not set. Set it to your Geode SDK path.")
endif()

get_cmake_property(CLICKSMITH_CACHE_VARS CACHE_VARIABLES)
foreach(CLICKSMITH_CACHE_VAR IN LISTS CLICKSMITH_CACHE_VARS)
  if(CLICKSMITH_CACHE_VAR MATCHES "^(CPM_|FETCHCONTENT_|FMT_|GeodeBindings_|GeodeResult_|TulipHookRoot_|arc_|asp_|mat-json_|nontype_functional_)")
    unset(${CLICKSMITH_CACHE_VAR} CACHE)
  endif()
endforeach()
set(FETCHCONTENT_BASE_DIR "${CMAKE_BINARY_DIR}/_deps" CACHE PATH "FetchContent dependency directory" FORCE)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON CACHE BOOL "Do not update cached Geode dependencies during normal builds" FORCE)

add_subdirectory($ENV{GEODE_SDK} geode-sdk)

add_library(${PROJECT_NAME} SHARED src/main.cpp)
target_compile_features(${PROJECT_NAME} PUBLIC cxx_std_20)

string(TIMESTAMP CLICKSMITH_ADAPTER_BUILD_TS "%Y%m%dT%H%M%S" UTC)
target_compile_definitions(${PROJECT_NAME} PRIVATE
  "CLICKSMITH_ADAPTER_BUILD_ID=\"0.2.7+${CLICKSMITH_ADAPTER_BUILD_TS}\""
)

set(GEODE_LINK_SOURCE ON)
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "")

setup_geode_mod(${PROJECT_NAME} DONT_INSTALL)
