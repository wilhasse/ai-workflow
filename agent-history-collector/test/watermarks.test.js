import test from 'node:test'
import assert from 'node:assert/strict'

import { needsRawLineWatermarkRepair } from '../src/watermarks.js'

test('legacy unchanged watermarks need one raw-line repair', () => {
  assert.equal(needsRawLineWatermarkRepair(100, { size: 100, lines: 29 }), true)
  assert.equal(needsRawLineWatermarkRepair(100, { size: 100, lines: 157, line_mode: 'raw' }), false)
  assert.equal(needsRawLineWatermarkRepair(120, { size: 100, lines: 29 }), false)
})
