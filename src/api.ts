import { Hono } from 'hono'
import form from './form'
import user from './user'
import auth from './auth'

const api = new Hono()

api.route('/forms', form)
api.route('/user', user)
api.route('/auth', auth)


export default api
