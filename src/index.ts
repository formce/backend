import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {logger} from 'hono/logger'
import api from './api'

const app = new Hono()

app.use(cors())
app.use(logger())

app.get('/', (c) => {
  return c.json({ status: 'up', actions: 'working test 2'})
})

app.route('/api', api)

// Bun.serve({
//   fetch: app.fetch,
//   port: 3000,
//   hostname: '0.0.0.0',   // THIS IS THE KEY
// })

export default app
