import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildThreadStartParams,
  validateComparisonPresets,
  validateCwd,
} from '../src/presets.js'

test('maps named provider presets without accepting arbitrary models', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-preset-'))
  const config = { defaultCwd: cwd, allowedRoots: [cwd] }

  const { params } = buildThreadStartParams({
    preset: 'k3',
    cwd,
    sandbox: 'workspaceWrite',
    approvalPolicy: 'onRequest',
  }, config)

  assert.deepEqual(params, {
    cwd,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    serviceName: 'ai_workflow_agent_board',
    ephemeral: false,
    model: 'kimi-k3',
    modelProvider: 'cliproxy',
  })
  assert.throws(() => buildThreadStartParams({ preset: 'arbitrary', cwd }, config), /Unknown preset/)
})

test('comparison presets are distinct and allowlisted', () => {
  assert.deepEqual(validateComparisonPresets(['default', 'k3', 'qwen', 'k3']), ['default', 'k3', 'qwen'])
  assert.throws(() => validateComparisonPresets(['default']), /two or three/)
  assert.throws(() => validateComparisonPresets(['default', 'other']), /Unknown preset/)
})

test('workspace validation rejects paths outside configured roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-root-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-outside-'))
  const config = { defaultCwd: root, allowedRoots: [root] }

  assert.equal(validateCwd(root, config), root)
  assert.throws(() => validateCwd(outside, config), /outside the allowed roots/)
})
