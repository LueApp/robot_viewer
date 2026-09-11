import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, mapSnapshot, LiveRecording, recordedClipData } from '../../src/integrations/LiveState.js';

const sample = () => ({ type:'state',version:1,session:'run',sequence:1,simulation_time:0,status:'running',robot:'arm',joints:{elbow:{position:2,unit:'rad'}} });
const model = { joints:new Map([['elbow_joint',{type:'revolute',limits:{lower:-1,upper:1}}]]) };

test('joint mapping preserves out-of-limit telemetry and reports mismatches', () => {
  const mapped = mapSnapshot(sample(),model,{elbow:'elbow_joint'});
  assert.equal(mapped.values.elbow_joint,2);
  assert.match(mapped.diagnostics[0],/exceeds/);
  assert.ok(mapSnapshot(sample(),model).diagnostics.some(message => message.includes('unknown')));
});
test('bad numeric state and duplicate mappings are rejected', () => {
  const bad=sample();bad.joints.elbow.position=NaN;
  assert.throws(()=>validateSnapshot(bad),/invalid position/);
  const duplicate=sample();duplicate.joints.other={position:0,unit:'rad'};
  assert.throws(()=>mapSnapshot(duplicate,model,{elbow:'elbow_joint',other:'elbow_joint'}),/Duplicate/);
});
test('recording separates sessions and gaps and preserves its original snapshots', () => {
  const recording=new LiveRecording();const a=sample();recording.append(a);
  a.joints.elbow.position=99;
  assert.equal(recording.data.segments[0].samples[0].joints.elbow.position,2);
  recording.append({...sample(),sequence:2,simulation_time:0.1},{},true);
  recording.append({...sample(),session:'next'});
  assert.equal(recording.data.segments.length,3);
  assert.equal(LiveRecording.load(recording.data).count,3);
});
test('recording capacity and time order are enforced', () => {
  const recording=new LiveRecording(1);recording.append(sample());
  assert.throws(()=>recording.append(sample()),/limit/);
});

test('animation copy preserves mapped positions and rebases recorded time', () => {
  const recording=new LiveRecording();
  recording.append({...sample(),simulation_time:10},{elbow:'elbow_joint'});
  recording.append({...sample(),sequence:2,simulation_time:10.5,joints:{elbow:{position:0.25,unit:'rad'}}},{elbow:'elbow_joint'});
  const before=JSON.stringify(recording.data);
  const result=recordedClipData(recording.data.segments[0],model);
  assert.equal(result.durationMs,500);
  assert.deepEqual(result.tracks,[{jointName:'elbow_joint',points:[[0,2],[500,0.25]]}]);
  assert.equal(JSON.stringify(recording.data),before);
});

test('empty, zero-duration and unmapped recordings explain why no clip can be made', () => {
  assert.throws(()=>recordedClipData(null,model),/Record motion/);
  assert.throws(()=>recordedClipData({samples:[sample()]},model),/no elapsed/);
  assert.throws(()=>recordedClipData({samples:[sample(),{...sample(),simulation_time:1}],mapping:{}},model),/No recorded joints match/);
  assert.deepEqual(mapSnapshot(sample(),model,{elbow:null}).values,{});
});
