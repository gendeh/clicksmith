cmake_minimum_required(VERSION 3.21)
project(clicksmith_geode_adapter VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED ENV{GEODE_SDK})
  message(FATAL_ERROR "GEODE_SDK is not set. Set it to your Geode SDK path.")
endif()

add_subdirectory($ENV{GEODE_SDK} geode-sdk)

add_library(${PROJECT_NAME} SHARED src/main.cpp)
target_compile_features(${PROJECT_NAME} PUBLIC cxx_std_20)

set(GEODE_LINK_SOURCE ON)
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "")

setup_geode_mod(${PROJECT_NAME})
