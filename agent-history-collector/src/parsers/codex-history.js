import fs from 'node:fs'
import readline from 'node:readline'
import config from '../config.js'

// Parses ~/.codex/history.jsonl
// Each line: { session_id, ts (unix seconds), text }
export async function* parse(filePath, startLine = 0) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lineNum = 0

  for await (const line of rl) {
    lineNum++
    if (lineNum <= startLine) continue
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch { continue }

    yield {
      session_id: rec.session_id ?? '',
      vm_id: config.vmId,
      source: 'codex',
      timestamp: rec.ts ? rec.ts * 1000 : Date.now(), // convert unix seconds to ms
      project: null,
      display_text: rec.text ?? null,
      pasted_contents: null,
    }
  }
}
