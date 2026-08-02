cmake_minimum_required(VERSION 3.24)
project(uci_arena_background_service_runtime LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "UCI Arena background service helpers are Windows-only")
endif()

add_executable(uci_arena_background_guard uci_arena_background_guard.cpp)
target_compile_features(uci_arena_background_guard PRIVATE cxx_std_20)
target_compile_definitions(uci_arena_background_guard PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX WINVER=0x0A00 _WIN32_WINNT=0x0A00)
target_link_libraries(uci_arena_background_guard PRIVATE PowrProf)

add_executable(uci_arena_service_launcher WIN32 uci_arena_service_launcher.cpp)
target_compile_features(uci_arena_service_launcher PRIVATE cxx_std_20)
target_compile_definitions(uci_arena_service_launcher PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
target_link_libraries(uci_arena_service_launcher PRIVATE Shell32)

if(MSVC)
    set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION bin)
    include(InstallRequiredSystemLibraries)
    foreach(runtime_library IN LISTS CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
        get_filename_component(runtime_name "${runtime_library}" NAME)
        string(TOLOWER "${runtime_name}" runtime_name_lower)
        if(runtime_name_lower MATCHES "^(api-ms-|ext-ms-)"
           OR runtime_name_lower STREQUAL "ucrtbase.dll")
            message(FATAL_ERROR
                "OS-owned Windows runtime library cannot enter the application-local package: ${runtime_library}")
        endif()
    endforeach()
    target_compile_options(uci_arena_background_guard PRIVATE /W4 /permissive- /EHsc)
    target_compile_options(uci_arena_service_launcher PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(uci_arena_background_guard PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_options(uci_arena_service_launcher PRIVATE -Wall -Wextra -Wpedantic)
endif()

install(TARGETS uci_arena_background_guard uci_arena_service_launcher RUNTIME DESTINATION bin)
