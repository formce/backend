import { Database } from "bun:sqlite";
import { Session } from "./auth";

const db = new Database("src/db/formce.db");

export const authMiddleware = async (c: any, next: any) => {
  const token = c.req.header('Authorization')
  if (!token) {
    return c.json({ message: 'Unauthorized' }, 401)
  }
  const session = await db.query(`
    SELECT * FROM sessions WHERE token = ?
  `).get(token)

  if (!session) {
    return c.json({ message: 'Invalid token' }, 401)
  }

  const user = await db.query(`
    SELECT * FROM users WHERE id = ?
  `).get((session as Session).user_id)

  if (!user) {
    return c.json({ message: 'User not found' }, 404)
  }
  await next()
}
