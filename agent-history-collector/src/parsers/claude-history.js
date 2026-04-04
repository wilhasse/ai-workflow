import fs from 'node:fs'
import readline from 'node:readline'
import config from '../config.js'

// Parses ~/.claude/history.jsonl
// Each line: { display, timestamp, project, sessionId, pastedContents }
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
      session_id: rec.sessionId ?? '',
      vm_id: config.vmId,
      source: 'claude',
      timestamp: rec.timestamp,
      project: rec.project ?? null,
      display_text: rec.display ?? null,
      pasted_contents: rec.pastedContents && Object.keys(rec.pastedContents).length ? rec.pastedContents : null,
    }
  }
}
