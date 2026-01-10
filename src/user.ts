import { Hono } from 'hono'
import { Database } from "bun:sqlite";

const db = new Database("src/db/formce.db");

const user = new Hono()

user.post("/", async (c) => {
  const { email, password } = await c.req.json()
  const hashPassword = await Bun.password.hash(password)
  const data = await db.run(`
    INSERT INTO users (email, password_hash)
    VALUES (?, ?)
  `, [email, hashPassword])
  const userId = data.lastInsertRowid
  return c.json({ message: 'User registered successfully', userId })
})

export default user
