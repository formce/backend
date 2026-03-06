import { Hono } from 'hono'
import project from './project'
import user from './user'
import auth from './auth'

const api = new Hono()

api.route('/projects', project)
api.route('/user', user)
api.route('/auth', auth)


export default api
