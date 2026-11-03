// No production DSH, model calls, or QQ messages; all writes use a temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {resolveInstalledPreset, synchronizePreset} from '../src/preset-sync.js';
import {renderPatch} from './build-agent-preset-patches.mjs';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-preset-sync-'));
const knownPresetName=name=>['qq-chat','qq-chat-v2'].includes(name);
const source=path.join(temp,'source.yml'),name='qq-chat-v2';
const bundle=path.join(temp,'plugins','qq-agent-presets','presets',name+'.patch.yml');
const legacy=path.join(temp,'.agent-presets',name,'agent.cordis.yml');
let writes=0;
const options={knownPresetName,sourceFor:()=>source,renderPatch,writeText:(file,text)=>{writes++;fs.writeFileSync(file,text);}};
try {
  fs.writeFileSync(source,'source-persona');
  fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.writeFileSync(legacy,'legacy-old');
  assert.equal(resolveInstalledPreset(name,{home:temp,knownPresetName}),legacy);
  fs.mkdirSync(path.dirname(bundle),{recursive:true});fs.writeFileSync(bundle,'stale bundle');
  assert.equal(resolveInstalledPreset(name,{home:temp,knownPresetName}),bundle,'installed bundle takes precedence over legacy copy');

  let result=synchronizePreset(name,bundle,options);
  assert.deepEqual(result,{synced:true,changed:true});
  const parsed=yaml.load(fs.readFileSync(bundle,'utf8'));
  assert.ok(Array.isArray(parsed[0].insert),'bundle remains an insert patch, never a raw agent plugin list');
  assert.equal(parsed[0].insert[0].id,'preset-qq-chat-v2');
  assert.ok(parsed[0].insert[0].config.plugins.some(row=>row.id==='persona'));
  const before=fs.readFileSync(bundle,'utf8');
  result=synchronizePreset(name,bundle,options);
  assert.deepEqual(result,{synced:true,changed:false});assert.equal(writes,1,'unchanged content is not rewritten');
  assert.equal(fs.readFileSync(bundle,'utf8'),before);
  assert.deepEqual(synchronizePreset(name,legacy,options),{synced:true,changed:true});
  assert.equal(fs.readFileSync(legacy,'utf8'),'source-persona');
  const missing=path.join(temp,'not-installed.patch.yml');
  assert.deepEqual(synchronizePreset(name,missing,options),{synced:false,changed:false});
  assert.equal(fs.existsSync(missing),false,'do not silently install a missing preset');
  assert.throws(()=>resolveInstalledPreset('../bad',{home:temp,knownPresetName}),/Unknown preset/);
  assert.throws(()=>synchronizePreset('../bad',bundle,options),/Unknown preset/);
} finally {fs.rmSync(temp,{recursive:true,force:true});}

const h=await bridgeHarness({files:{'dsh/agent-presets/qq-chat-v2/agent.cordis.yml':'source-persona'},
  globals:{renderPatch:name=>'rendered:'+name}});
try {
  const target=path.join(h.temp,'installed.patch.yml');fs.writeFileSync(target,'stale');
  assert.deepEqual(h.syncInstalledPreset('qq-chat-v2',target),{synced:true,changed:true});
  assert.equal(fs.readFileSync(target,'utf8'),'rendered:qq-chat-v2');
  const result=h.syncInstalledPreset('qq-chat-v2',target);
  assert.equal(result.synced,true);assert.equal(result.changed,false);
} finally {await h.close();}
console.log('PASS installed preset resolution, bundle rendering, legacy fallback, idempotence and bridge wiring');
