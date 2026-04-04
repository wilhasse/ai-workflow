import mysql from 'mysql2/promise'
import config from '../config.js'

let pool = null

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.doris.host,
      port: config.doris.port,
      user: config.doris.user,
      password: config.doris.password,
      database: config.doris.database,
      connectionLimit: config.doris.connectionLimit,
      connectTimeout: config.doris.connectTimeout,
    })
  }
  return pool
}

export async function checkConnection() {
  const p = getPool()
  const conn = await p.getConnection()
  try {
    await conn.query('SELECT 1')
    return true
  } finally {
    conn.release()
  }
}
