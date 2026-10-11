import test from 'node:test';
import assert from 'node:assert/strict';
import { admitBookTaskDefinition } from '../src/provider_task_xml.mjs';
import { buildTaskXml, startupAction } from '../src/windows_startup.mjs';

function fixture() {
  const descriptor = { root: 'C:\\Owned & Fixture', packageRoot: 'C:\\Owned & Fixture\\services\\book-forge',
    cli: 'C:\\Owned & Fixture\\services\\book-forge\\src\\cli.mjs', launcher: 'C:\\Owned & Fixture\\launcher.exe' };
  const config = { workspace: 'C:\\Workspace &#65;', configFile: 'C:\\Workspace &#65;\\config.json' };
  const raw = startupAction(config, { descriptor, nodeExecutable: 'C:\\Node\\node.exe' });
  return { action: { command: raw.command, arguments: raw.arguments, working_directory: raw.workingDirectory },
    xml: buildTaskXml(config, 'S-1-5-21-123', { descriptor, nodeExecutable: 'C:\\Node\\node.exe', enabled: false }) };
}
test('genuine producer XML preserves original settings/triggers and exact once-decoded Exec tuple', () => {
  const { xml, action } = fixture(); const original = xml;
  assert.deepEqual(admitBookTaskDefinition(xml, action, { enabled: false }), { action, enabled: false });
  assert.equal(xml, original); assert.match(xml, /<LogonTrigger>/); assert.match(xml, /<UseUnifiedSchedulingEngine>true/);
  const numeric = xml.replace('<Command>C:', '<Command>&#67;:').replaceAll('&amp;', '&#x26;');
  assert.deepEqual(admitBookTaskDefinition(numeric, action), { action, enabled: false });
  // Literal '&#65;' survives one XML decode; it must never become 'A'.
  assert.match(admitBookTaskDefinition(xml, action).action.arguments, /&#65;/);
  // Missing Settings/Enabled uses the public Task default only.
  const removed = xml.replace(/(<Settings>[\s\S]*?)<Enabled>false<\/Enabled>/u, '$1');
  assert.equal(admitBookTaskDefinition(removed, action, { enabled: true }).enabled, true);
});
test('foreign tuples, duplicate action fields, namespace/entity ambiguity and malformed markup reject', () => {
  const { xml, action } = fixture();
  const exec = /<Exec>[\s\S]*?<\/Exec>/u.exec(xml)[0];
  const actions = /<Actions[^>]*>[\s\S]*?<\/Actions>/u.exec(xml)[0];
  const changes = [
    xml.replace(/<Command>[^<]+<\/Command>/u, '<Command>C:\\foreign.exe</Command>'),
    xml.replace(/<Arguments>[^<]+<\/Arguments>/u, '<Arguments>foreign</Arguments>'),
    xml.replace(/<WorkingDirectory>[^<]+<\/WorkingDirectory>/u, '<WorkingDirectory>C:\\foreign</WorkingDirectory>'),
    xml.replace(exec, exec + exec), xml.replace('</Actions>', '</Actions>' + actions),
    xml.replace('</Command>', '</Command><Command>C:\\foreign.exe</Command>'),
    xml.replace('<Exec>', '<Exec xmlns="urn:foreign">'),
    xml.replaceAll('Exec>', 'x:Exec>'), xml.replace('xmlns="http:', 'xmlns="urn:'),
    xml.replace('<Command>', '<Command><!--ignored-->'),
    xml.replace('<Command>', '<Command><![CDATA[foreign]]>'),
    '<!DOCTYPE Task [<!ENTITY x "foreign">]>' + xml,
    xml.replace('&amp;', '&unknown;'), xml.replace('&amp;', '&#0;'),
    xml.replace('</Command>', '</ Command>'), xml.replace('</Task>', '</Task>' + actions),
    xml.replace(/(<Settings>[\s\S]*?<Enabled>false<\/Enabled>)/u, '$1<Enabled>true</Enabled>'),
    xml.replace('</RegistrationInfo>', exec + '</RegistrationInfo>'),
    xml.replace('<Task version=', '<Task __proto__="ignored" version='),
  ];
  for (const changed of changes) assert.throws(() => admitBookTaskDefinition(changed, action));
  assert.throws(() => admitBookTaskDefinition(xml, action, { enabled: true }));
});
