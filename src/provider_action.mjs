import path from 'node:path';

const validText = value => typeof value === 'string' && value.isWellFormed() &&
  value.length <= 32767 && !/[\u0000\r\n]/u.test(value);
const absolute = value => validText(value) && (/^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value));
const normalized = value => path.win32.normalize(value).replace(/[\\/]+$/u, '').toLowerCase();
const equalPath = (a, b) => absolute(a) && absolute(b) && normalized(a) === normalized(b);
const rejected = () => new Error('Book task action admission failed');

// The producer owns the exact public launcher argv grammar. This is not a
// process-commandline query or an invitation to execute arbitrary task strings.
export function parseWindowsArguments(value) {
  if (!validText(value)) throw rejected();
  const result = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[ \t]/u.test(value[cursor] ?? '') && cursor < value.length) cursor++;
    if (cursor === value.length) break;
    let token = '', quoted = false;
    while (cursor < value.length && (quoted || !/[ \t]/u.test(value[cursor]))) {
      if (value[cursor] === '\\') {
        let count = 0;
        while (value[cursor] === '\\') { count++; cursor++; }
        if (value[cursor] === '"') {
          token += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) { token += '"'; cursor++; }
          else { quoted = !quoted; cursor++; }
        } else token += '\\'.repeat(count);
      } else if (value[cursor] === '"') {
        if (quoted && value[cursor + 1] === '"') { token += '"'; cursor += 2; }
        else { quoted = !quoted; cursor++; }
      } else token += value[cursor++];
    }
    if (quoted || result.length === 8) throw rejected();
    result.push(token);
  }
  return result;
}

export function bindWindowsTaskToRoot(observation, descriptor, config) {
  try {
    const action = observation?.action;
    if (observation?.registered !== true || descriptor?.schema !== 'uci_arena_book_component_root_v1' ||
        !action || !equalPath(action.command, descriptor.launcher) ||
        !equalPath(action.working_directory, descriptor.packageRoot)) throw rejected();
    const argv = parseWindowsArguments(action.arguments);
    const expected = config.configFile ? 8 : 6;
    if (argv.length !== expected || argv[0] !== '--restart' || !absolute(argv[1]) ||
        !equalPath(argv[2], descriptor.cli) || argv[3] !== 'daemon' || argv[4] !== '--workspace' ||
        !equalPath(argv[5], config.workspace) || (expected === 8 &&
          (argv[6] !== '--config' || !equalPath(argv[7], config.configFile)))) throw rejected();
    return Object.freeze({ nodeExecutable: argv[1], action: Object.freeze({ command: action.command,
      arguments: action.arguments, working_directory: action.working_directory }) });
  } catch { throw rejected(); }
}
