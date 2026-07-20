#include <windows.h>
#include <powrprof.h>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

int probe() {
    LASTINPUTINFO input{};
    input.cbSize = sizeof(input);
    const bool have_input = GetLastInputInfo(&input) != FALSE;
    const auto input_idle_ms = have_input
        ? static_cast<std::uint32_t>(GetTickCount() - input.dwTime)
        : 0U;

    SYSTEM_POWER_STATUS power{};
    const bool have_power = GetSystemPowerStatus(&power) != FALSE;
    const bool on_battery = have_power && power.ACLineStatus == 0;
    const bool battery_saver = have_power && power.SystemStatusFlag != 0;

    struct SystemPowerInfoData {
        ULONG max_idleness_allowed;
        ULONG idleness;
        ULONG time_remaining;
        UCHAR cooling_mode;
    } system_power{};
    const auto power_status = CallNtPowerInformation(
        SystemPowerInformation,
        nullptr,
        0,
        &system_power,
        static_cast<ULONG>(sizeof(system_power))
    );
    const auto cooling_mode = power_status == ERROR_SUCCESS
        ? static_cast<unsigned long>(system_power.cooling_mode)
        : 0UL;

    struct ProcessorPowerInfo {
        ULONG number;
        ULONG max_mhz;
        ULONG current_mhz;
        ULONG mhz_limit;
        ULONG max_idle_state;
        ULONG current_idle_state;
    };
    const auto processor_count = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    std::vector<ProcessorPowerInfo> processor_power(processor_count);
    unsigned long processor_limit_percent = 100;
    if (!processor_power.empty() && CallNtPowerInformation(
            ProcessorInformation,
            nullptr,
            0,
            processor_power.data(),
            static_cast<ULONG>(processor_power.size() * sizeof(ProcessorPowerInfo))) == ERROR_SUCCESS) {
        for (const auto& processor : processor_power) {
            if (processor.max_mhz > 0) {
                processor_limit_percent = std::min(
                    processor_limit_percent,
                    static_cast<unsigned long>(100ULL * processor.mhz_limit / processor.max_mhz)
                );
            }
        }
    }

    std::cout
        << "{\"schema\":\"flashfork_book_forge_native_probe_v1\""
        << ",\"on_battery\":" << (on_battery ? "true" : "false")
        << ",\"battery_saver\":" << (battery_saver ? "true" : "false")
        << ",\"input_idle_ms\":" << input_idle_ms
        << ",\"cooling_mode\":" << cooling_mode
        << ",\"processor_limit_percent\":" << processor_limit_percent
        << "}\n";
    return 0;
}

void apply_process_courtesy(HANDLE process) {
    SetPriorityClass(process, IDLE_PRIORITY_CLASS);

#if defined(PROCESS_POWER_THROTTLING_CURRENT_VERSION) && defined(PROCESS_POWER_THROTTLING_EXECUTION_SPEED)
    PROCESS_POWER_THROTTLING_STATE throttling{};
    throttling.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    throttling.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    throttling.StateMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    SetProcessInformation(process, ProcessPowerThrottling, &throttling, sizeof(throttling));
#endif

    using NtSetInformationProcess = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG);
    const auto ntdll = GetModuleHandleW(L"ntdll.dll");
    const auto set_information = reinterpret_cast<NtSetInformationProcess>(
        ntdll == nullptr ? nullptr : GetProcAddress(ntdll, "NtSetInformationProcess")
    );
    if (set_information != nullptr) {
        ULONG very_low_io_priority = 0;
        constexpr ULONG process_io_priority = 33;
        set_information(process, process_io_priority, &very_low_io_priority, sizeof(very_low_io_priority));
    }
}

bool heartbeat_stale(const std::string& filename, std::uint64_t stale_seconds) {
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (GetFileAttributesExA(filename.c_str(), GetFileExInfoStandard, &attributes) == FALSE) return true;
    FILETIME now_file_time{};
    GetSystemTimeAsFileTime(&now_file_time);
    ULARGE_INTEGER now{};
    now.LowPart = now_file_time.dwLowDateTime;
    now.HighPart = now_file_time.dwHighDateTime;
    ULARGE_INTEGER written{};
    written.LowPart = attributes.ftLastWriteTime.dwLowDateTime;
    written.HighPart = attributes.ftLastWriteTime.dwHighDateTime;
    const auto maximum_age = stale_seconds * 10'000'000ULL;
    return now.QuadPart > written.QuadPart && now.QuadPart - written.QuadPart > maximum_age;
}

int supervise(DWORD process_id, const std::string& heartbeat_file, std::uint64_t stale_seconds) {
    const auto process = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE,
        FALSE,
        process_id
    );
    if (process == nullptr) {
        std::cerr << "Could not open Book Forge process " << process_id << "\n";
        return 2;
    }

    apply_process_courtesy(process);

    const auto job = CreateJobObjectW(nullptr, nullptr);
    if (job != nullptr) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE) {
            AssignProcessToJobObject(job, process);
        }
    }

    for (;;) {
        const auto wait = WaitForSingleObject(process, 15'000);
        if (wait == WAIT_OBJECT_0) break;
        if (wait != WAIT_TIMEOUT) break;
        if (heartbeat_stale(heartbeat_file, stale_seconds)) {
            std::cerr << "Book Forge heartbeat is stale; terminating process " << process_id << "\n";
            TerminateProcess(process, 70);
            WaitForSingleObject(process, 10'000);
            break;
        }
    }
    if (job != nullptr) CloseHandle(job);
    CloseHandle(process);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--probe") return probe();
    if (argc == 7 && std::string_view(argv[1]) == "--supervise" &&
        std::string_view(argv[3]) == "--heartbeat" && std::string_view(argv[5]) == "--stale-seconds") {
        try {
            const auto process_id = static_cast<DWORD>(std::stoul(argv[2]));
            const auto stale_seconds = std::stoull(argv[6]);
            return process_id == 0 || stale_seconds == 0 ? 2 : supervise(process_id, argv[4], stale_seconds);
        } catch (...) {
            return 2;
        }
    }
    std::cerr << "Usage: book_forge_guard --probe | --supervise <pid> --heartbeat <path> --stale-seconds <seconds>\n";
    return 2;
}
