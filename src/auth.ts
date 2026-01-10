import { Hono } from 'hono'
import { Database } from "bun:sqlite";
import {authMiddleware} from './middlewares';

const db = new Database("src/db/formce.db");

const auth = new Hono()

interface User {
  id: number,
  email: string,
  password_hash: string
}

export interface Session {
  id: number,
  user_id: number,
  token: string,
  created_at: string,
  expires_at: string
}

auth.post("/login", async (c) => {
  const { email, password } = await c.req.json()
  const user = await db.query(`
    SELECT usr.id, usr.email, usr.password_hash FROM users as usr WHERE email = ?
  `).get(email)
  if (!user) {
    return c.json({ message: 'User not found' }, 404)
  }
  const isValid = await Bun.password.verify(password, (user as User).password_hash)
  if (!isValid) {
    return c.json({ message: 'Invalid password' }, 401)
  }

  // Create a session token using Bun.randomUUIDv7();
  const token = Bun.randomUUIDv7();

  await db.run(`
    INSERT INTO sessions (user_id, token)
    VALUES (?, ?)
  `, [(user as User).id, token])

  return c.json({ message: 'Login successful', userId: (user as User).id, token })
})

// Use authMiddleware to protect this route
auth.use(authMiddleware)

auth.post("/logout", async (c) => {
  const token = c.req.header('Authorization')
  if (!token) {
    return c.json({ message: 'Unauthorized' }, 401)
  }
  await db.run(`
    DELETE FROM sessions WHERE token = ?
  `, [token])
  return c.json({ message: 'Logout successful' })
})

export default auth
