cmake_minimum_required(VERSION 3.24)
project(book_forge_guard LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "book_forge_guard is a Windows-only resource-control helper")
endif()

add_executable(book_forge_guard book_forge_guard.cpp)
target_compile_features(book_forge_guard PRIVATE cxx_std_20)
target_compile_definitions(book_forge_guard PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX WINVER=0x0A00 _WIN32_WINNT=0x0A00)
target_link_libraries(book_forge_guard PRIVATE PowrProf)

add_executable(book_forge_launcher WIN32 book_forge_launcher.cpp)
target_compile_features(book_forge_launcher PRIVATE cxx_std_20)
target_compile_definitions(book_forge_launcher PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
target_link_libraries(book_forge_launcher PRIVATE Shell32)

if(MSVC)
    target_compile_options(book_forge_guard PRIVATE /W4 /permissive- /EHsc)
    target_compile_options(book_forge_launcher PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(book_forge_guard PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_options(book_forge_launcher PRIVATE -Wall -Wextra -Wpedantic)
endif()
