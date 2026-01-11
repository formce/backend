import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {logger} from 'hono/logger'
import api from './api'

const app = new Hono()

app.use(cors())
app.use(logger())

app.get('/', (c) => {
  return c.json({ status: 'up' })
})

app.route('/api', api)

export default app
