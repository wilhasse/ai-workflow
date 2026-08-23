import mysql from 'mysql2/promise'
import config from '../config.js'

let pool

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.mysql,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
    })
  }
  return pool
}

export async function checkConnection() {
  const [rows] = await getPool().query('SELECT 1 AS ok')
  return rows[0].ok === 1
}
