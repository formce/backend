import { Hono } from 'hono'
import project from './project'
import user from './user'
import auth from './auth'
import { googleIntegrations } from './integrations/google'

const api = new Hono()

api.route('/projects', project)
api.route('/user', user)
api.route('/auth', auth)
api.route('/integrations/google', googleIntegrations)

export default api
