// Admission of this producer's captured canonical Task shape, not a general XML
// formatter. Preserve the entire before-image; derive only Exec and gate facts.
const failure = () => new Error('Book task definition consistency unavailable');
const namespace = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
const space = /^[\t\n\r ]*$/u;
const name = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const xmlChar = code => code === 9 || code === 10 || code === 13 ||
  (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
function decode(value) {
  const entity = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/gu;
  if (value.replace(entity, '').includes('&')) throw failure();
  return value.replace(/\r\n?/gu, '\n').replace(entity, token => {
    const predefined = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (Object.hasOwn(predefined, token)) return predefined[token];
    const code = token.startsWith('&#x') ? Number.parseInt(token.slice(3, -1), 16) : Number(token.slice(2, -1));
    if (!xmlChar(code)) throw failure();
    return String.fromCodePoint(code);
  });
}
function attributes(value) {
  const result = Object.create(null);
  while (!space.test(value)) {
    const found = /^[\t\n\r ]+([A-Za-z_][A-Za-z0-9_.-]*)[\t\n\r ]*=[\t\n\r ]*("[^"<]*"|'[^'<]*')/u.exec(value);
    if (!found || Object.hasOwn(result, found[1])) throw failure();
    result[found[1]] = decode(found[2].slice(1, -1)).replace(/[\t\n\r]/gu, ' ');
    value = value.slice(found[0].length);
  }
  return result;
}
function document(input) {
  if (typeof input !== 'string' || !input.isWellFormed() || Buffer.byteLength(input) > 1048576) throw failure();
  for (const char of input) if (!xmlChar(char.codePointAt(0))) throw failure();
  input = input.replace(/^\ufeff/u, '');
  let cursor = 0, root = null, count = 0;
  const stack = [];
  if (input.startsWith('<?xml')) {
    const end = input.indexOf('?>');
    if (end < 0 || input.slice(5, end).includes('&')) throw failure();
    const declaration = attributes(input.slice(5, end));
    if (declaration.version !== '1.0' || Object.keys(declaration).some(key => !['version', 'encoding', 'standalone'].includes(key)) ||
        (declaration.encoding && !/^UTF-(?:8|16)$/iu.test(declaration.encoding)) ||
        (declaration.standalone && !['yes', 'no'].includes(declaration.standalone))) throw failure();
    cursor = end + 2;
  }
  while (cursor < input.length) {
    const begin = input.indexOf('<', cursor);
    const rawText = input.slice(cursor, begin < 0 ? input.length : begin);
    if (rawText.includes(']]>')) throw failure();
    const text = decode(rawText);
    if (!stack.length) { if (!space.test(text)) throw failure(); }
    else stack.at(-1).text += text;
    if (begin < 0) { cursor = input.length; break; }
    // DTD, entity declarations, comments, CDATA, processing instructions and
    // namespace prefixes are unsupported; never guess their action meaning.
    if (input[begin + 1] === '!' || input[begin + 1] === '?') throw failure();
    let end = begin + 1, quote = null;
    for (; end < input.length; end++) {
      const char = input[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === input.length) throw failure();
    const token = input.slice(begin + 1, end); cursor = end + 1;
    if (token.startsWith('/')) {
      const closing = /^\/([A-Za-z_][A-Za-z0-9_.-]*)[\t\n\r ]*$/u.exec(token);
      if (!closing || !name.test(closing[1]) || stack.pop()?.name !== closing[1]) throw failure();
      continue;
    }
    const selfClosing = token.endsWith('/'); const body = selfClosing ? token.slice(0, -1) : token;
    const found = /^([A-Za-z_][A-Za-z0-9_.-]*)([\s\S]*)$/u.exec(body);
    if (!found || ++count > 4096 || stack.length >= 64) throw failure();
    const node = { name: found[1], attrs: attributes(found[2]), children: [], text: '' };
    if (stack.length) {
      if (Object.hasOwn(node.attrs, 'xmlns')) throw failure();
      stack.at(-1).children.push(node);
    } else {
      if (root || node.name !== 'Task' || node.attrs.xmlns !== namespace || !/^1\.[1-4]$/u.test(node.attrs.version ?? '') ||
          Object.keys(node.attrs).some(key => !['xmlns', 'version'].includes(key))) throw failure();
      root = node;
    }
    if (!selfClosing) stack.push(node);
  }
  if (!root || stack.length) throw failure();
  return root;
}
const children = (node, selected) => node.children.filter(child => child.name === selected);
function leaf(node) { if (node.children.length || Object.keys(node.attrs).length) throw failure(); return node.text; }
export function admitBookTaskDefinition(xml, expectedAction, { enabled = undefined } = {}) {
  const root = document(xml);
  const nodes = [root], counts = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]; counts.set(node.name, (counts.get(node.name) ?? 0) + 1); nodes.push(...node.children);
  }
  if (['Task', 'Actions', 'Exec', 'Command', 'Arguments', 'WorkingDirectory'].some(field => counts.get(field) !== 1) ||
      (counts.get('Settings') ?? 0) > 1) throw failure();
  if (!space.test(root.text) || children(root, 'Actions').length !== 1 || children(root, 'Settings').length > 1) throw failure();
  const actions = children(root, 'Actions')[0];
  if (!space.test(actions.text) || actions.children.length !== 1 || actions.children[0].name !== 'Exec') throw failure();
  const exec = actions.children[0];
  if (!space.test(exec.text) || exec.children.length !== 3) throw failure();
  const mapping = { Command: 'command', Arguments: 'arguments', WorkingDirectory: 'working_directory' };
  const action = {};
  for (const [field, key] of Object.entries(mapping)) {
    const selected = children(exec, field); if (selected.length !== 1) throw failure();
    action[key] = leaf(selected[0]);
    if (typeof expectedAction?.[key] !== 'string' || action[key] !== expectedAction[key]) throw failure();
  }
  const gate = children(root, 'Settings')[0];
  const bits = gate ? children(gate, 'Enabled') : [];
  if (bits.length > 1 || (gate && !space.test(gate.text))) throw failure();
  const bit = bits.length ? leaf(bits[0]).trim() : 'true';
  if (!['true', 'false', '1', '0'].includes(bit)) throw failure();
  const actualEnabled = ['true', '1'].includes(bit);
  if (enabled !== undefined && (typeof enabled !== 'boolean' || enabled !== actualEnabled)) throw failure();
  return Object.freeze({ action: Object.freeze(action), enabled: actualEnabled });
}
