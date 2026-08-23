import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-app-server' } })
  } else if (message.method === 'echo') {
    send({ id: message.id, result: message.params })
  } else if (message.method === 'request-approval') {
    send({ id: message.id, result: {} })
    send({
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'pwd' },
    })
  }
})
