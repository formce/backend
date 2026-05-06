import { Hono } from 'hono'
import project from './project'
import user from './user'
import auth from './auth'
import { googleIntegrations } from './integrations/google'
import { notionIntegrations } from './integrations/notion'
import { airtableIntegrations } from './integrations/airtable'

const api = new Hono()

api.route('/projects', project)
api.route('/user', user)
api.route('/auth', auth)
api.route('/integrations/google', googleIntegrations)
api.route('/integrations/notion', notionIntegrations)
api.route('/integrations/airtable', airtableIntegrations)

export default api
