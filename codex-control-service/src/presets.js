import fs from 'node:fs'
import path from 'node:path'

export const PRESETS = Object.freeze({
  default: Object.freeze({
    id: 'default',
    label: 'Codex default',
    description: 'Use the host Codex default model and provider.',
  }),
  k3: Object.freeze({
    id: 'k3',
    label: 'Kimi K3',
    description: 'Use the configured kimi-k3 model through cliproxy.',
    model: 'kimi-k3',
    modelProvider: 'cliproxy',
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen 3.8 Max',
    description: 'Use the configured qwen3.8-max model through cliproxy.',
    model: 'qwen3.8-max',
    modelProvider: 'cliproxy',
  }),
})

export const DEFAULT_COMPARISON_PRESETS = Object.freeze(['default', 'k3', 'qwen'])

export class InputError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'InputError'
    this.statusCode = statusCode
  }
}

export const getPreset = (presetId = 'default') => {
  const preset = PRESETS[String(presetId || 'default')]
  if (!preset) {
    throw new InputError(`Unknown preset: ${presetId}`)
  }
  return preset
}

export const validateText = (value, label, maxLength = 12000) => {
  const text = String(value || '').trim()
  if (!text) throw new InputError(`${label} is required`)
  if (text.length > maxLength) throw new InputError(`${label} exceeds ${maxLength} characters`)
  return text
}

const isWithinRoot = (target, root) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export const validateCwd = (value, config) => {
  const requested = path.resolve(String(value || config.defaultCwd))
  let realPath
  try {
    realPath = fs.realpathSync(requested)
  } catch {
    throw new InputError(`Workspace does not exist: ${requested}`)
  }
  if (!fs.statSync(realPath).isDirectory()) {
    throw new InputError(`Workspace is not a directory: ${realPath}`)
  }
  const allowed = config.allowedRoots.some((root) => {
    try {
      return isWithinRoot(realPath, fs.realpathSync(root))
    } catch {
      return false
    }
  })
  if (!allowed) throw new InputError(`Workspace is outside the allowed roots: ${realPath}`, 403)
  return realPath
}

export const validateSandbox = (value = 'workspaceWrite') => {
  const wireValues = {
    readOnly: 'read-only',
    workspaceWrite: 'workspace-write',
    'read-only': 'read-only',
    'workspace-write': 'workspace-write',
  }
  if (!wireValues[value]) {
    throw new InputError('sandbox must be readOnly or workspaceWrite')
  }
  return wireValues[value]
}

export const validateApprovalPolicy = (value = 'onRequest') => {
  const wireValues = {
    untrusted: 'untrusted',
    onRequest: 'on-request',
    'on-request': 'on-request',
    never: 'never',
  }
  if (!wireValues[value]) {
    throw new InputError('approvalPolicy must be untrusted, onRequest, or never')
  }
  return wireValues[value]
}

export const buildThreadStartParams = (input, config, overrides = {}) => {
  const preset = getPreset(input.preset)
  const params = {
    cwd: validateCwd(input.cwd, config),
    sandbox: validateSandbox(overrides.sandbox || input.sandbox),
    approvalPolicy: validateApprovalPolicy(overrides.approvalPolicy || input.approvalPolicy),
    serviceName: 'ai_workflow_agent_board',
    ephemeral: overrides.ephemeral ?? Boolean(input.ephemeral),
  }
  if (preset.model) params.model = preset.model
  if (preset.modelProvider) params.modelProvider = preset.modelProvider
  return { preset, params }
}

export const validateComparisonPresets = (value) => {
  const requested = Array.isArray(value) && value.length ? value : DEFAULT_COMPARISON_PRESETS
  const presetIds = [...new Set(requested.map((item) => getPreset(item).id))]
  if (presetIds.length < 2 || presetIds.length > DEFAULT_COMPARISON_PRESETS.length) {
    throw new InputError('Comparison requires two or three distinct presets')
  }
  return presetIds
}
