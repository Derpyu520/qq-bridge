import fs from 'node:fs';
import path from 'node:path';

// setup-dsh links qq-agent-presets into DSH_HOME/plugins.
export function resolveInstalledPreset(name, {home, knownPresetName}) {
  if (!knownPresetName(name)) throw new Error('Unknown preset');
  const bundle = path.join(home, 'plugins', 'qq-agent-presets', 'presets', name + '.patch.yml');
  if (fs.existsSync(bundle)) return bundle;
  return path.join(home, '.agent-presets', name, 'agent.cordis.yml');
}

// A bundle is a rendered patch; copying agent.cordis.yml would corrupt its shape.
export function synchronizePreset(name, target, {knownPresetName, sourceFor, renderPatch, writeText}) {
  if (!knownPresetName(name)) throw new Error('Unknown preset');
  if (!fs.existsSync(target)) return {synced: false, changed: false};
  const content = target.endsWith('.patch.yml') ? renderPatch(name) : fs.readFileSync(sourceFor(name), 'utf8');
  const changed = fs.readFileSync(target, 'utf8') !== content;
  if (changed) writeText(target, content);
  return {synced: true, changed};
}
