const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'supervisor.js'), 'utf8');
const match = source.match(/function continuationDecision\([\s\S]*?\n\}/);
assert.ok(match, 'continuationDecision should remain independently testable');

const context = {};
vm.createContext(context);
vm.runInContext(`${match[0]};globalThis.continuationDecision=continuationDecision`, context);

const decide = context.continuationDecision;
assert.equal(decide({fileSignal:false, allowUnconfirmed:false}), 'continue-no-file');
assert.equal(decide({fileSignal:false, allowUnconfirmed:true}), 'continue-no-file');
assert.equal(decide({fileSignal:true, downloadComplete:true, allowUnconfirmed:false}), 'continue-downloaded');
assert.equal(decide({fileSignal:true, allowUnconfirmed:true}), 'continue-unconfirmed');
assert.equal(decide({fileSignal:true, allowUnconfirmed:false}), 'wait-download');

assert.match(source, /pendingContinueMode:'no-file'/, 'no-file continuation must have its own pending mode');
assert.doesNotMatch(
  source,
  /严格模式：回复已完成，但未检测到可下载文件；等待文件/,
  'strict mode must never wait for a file that the reply did not claim to produce'
);

console.log('no-file continuation policy test passed');
