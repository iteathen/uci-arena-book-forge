cmake_minimum_required(VERSION 3.24)
project(book_forge_guard LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "book_forge_guard is a Windows-only resource-control helper")
endif()

add_executable(book_forge_guard book_forge_guard.cpp)
target_compile_features(book_forge_guard PRIVATE cxx_std_20)
target_compile_definitions(book_forge_guard PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(book_forge_guard PRIVATE PowrProf)

if(MSVC)
    target_compile_options(book_forge_guard PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(book_forge_guard PRIVATE -Wall -Wextra -Wpedantic)
endif()
