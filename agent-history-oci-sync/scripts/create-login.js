import { readFileSync } from 'node:fs'
import { hashPassword } from '../src/auth.js'

// Pipe the password through stdin; never put it in a command-line argument.
try {
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '')
  console.log(await hashPassword(password))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
