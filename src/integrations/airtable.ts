import { Hono } from 'hono';
import { Database } from "bun:sqlite";
import { authMiddleware } from '../middlewares';
import * as crypto from 'crypto';

const CODE_VERIFIER = 'formcesecureairtablepkcecodeverifierstring12345';
function getCodeChallenge(verifier: string) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const db = new Database("src/db/formce.db");
export const airtableIntegrations = new Hono<{ Variables: { userId: number } }>();

const AIRTABLE_CLIENT_ID = process.env.AIRTABLE_CLIENT_ID || 'your-client-id';
const AIRTABLE_CLIENT_SECRET = process.env.AIRTABLE_CLIENT_SECRET || 'your-client-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const REDIRECT_URI = `${BACKEND_URL}/api/integrations/airtable/callback`;

airtableIntegrations.get('/auth', authMiddleware, (c) => {
  const userId = c.get('userId');
  const projectId = c.req.query('projectId');

  const state = Buffer.from(JSON.stringify({ userId, projectId })).toString('base64');

  const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
  authUrl.searchParams.append('client_id', AIRTABLE_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'data.records:write schema.bases:read');
  authUrl.searchParams.append('code_challenge', getCodeChallenge(CODE_VERIFIER));
  authUrl.searchParams.append('code_challenge_method', 'S256');
  authUrl.searchParams.append('state', state);

  return c.redirect(authUrl.toString());
});

airtableIntegrations.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) return c.text('Missing code or state', 400);

  let userId: number;
  let projectId: string | undefined;
  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('ascii'));
    userId = decodedState.userId;
    projectId = decodedState.projectId;
  } catch (e) {
    return c.text('Invalid state', 400);
  }

  const credentials = Buffer.from(`${AIRTABLE_CLIENT_ID}:${AIRTABLE_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://airtable.com/oauth2/v1/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER
    })
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) return c.json(tokenData, 400);

  if (tokenData.refresh_token || tokenData.access_token) {
    const rToken = tokenData.refresh_token || tokenData.access_token;
    const stmt = db.prepare('UPDATE users SET airtable_refresh_token = ? WHERE id = ?');
    stmt.run(rToken, userId);
  }

  if (projectId) {
    return c.redirect(`${FRONTEND_URL}/projects/${projectId}?airtableConnected=true`);
  }
  return c.redirect(`${FRONTEND_URL}/projects/dashboard?airtableConnected=true`);
});

airtableIntegrations.post('/project/:id/table', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('id');
  const { baseId, tableName } = await c.req.json();

  const project = db.query("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId as number);
  if (!project) return c.json({ error: "Project not found or unauthorized" }, 404);

  const stmt = db.prepare('UPDATE projects SET airtable_base_id = ?, airtable_table_name = ? WHERE id = ?');
  stmt.run(baseId, tableName, projectId);

  return c.json({ success: true, message: 'Airtable Base and Table linked to project.' });
});

export async function appendRowToAirtableTable(projectId: string | number, userId: number, baseId: string, tableName: string, responses: any) {
  // 1. Fetch questions to map names
  const pages = db.query(`
    SELECT id, questions
    FROM pages
    WHERE project_id = ?
    ORDER BY order_index ASC, created_at ASC
  `).all(projectId) as any[];

  const questionsList: { pageId: number, questionId: number, title: string }[] = [];
  pages.forEach(page => {
    const pageQuestions = JSON.parse(page.questions || '[]');
    pageQuestions.forEach((q: any) => {
      questionsList.push({
        pageId: page.id,
        questionId: q.id,
        title: q.title
      });
    });
  });

  // 2. Get user's refresh token
  const user: any = db.query('SELECT airtable_refresh_token FROM users WHERE id = ?').get(userId);
  if (!user || !user.airtable_refresh_token) return false;

  // 3. Refresh access token
  const credentials = Buffer.from(`${AIRTABLE_CLIENT_ID}:${AIRTABLE_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://airtable.com/oauth2/v1/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.airtable_refresh_token
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("Airtable token refresh failed:", tokenData);
    return false;
  }

  // Update refresh token if shifted
  if (tokenData.refresh_token && tokenData.refresh_token !== user.airtable_refresh_token) {
    db.prepare('UPDATE users SET airtable_refresh_token = ? WHERE id = ?').run(tokenData.refresh_token, userId);
  }

  // 4. Map responses to fields
  const fields: any = {};
  questionsList.forEach(q => {
    const fieldName = String(q.title).trim();
    if (!fieldName) return;

    let ans = responses[`${q.pageId}_${q.questionId}`];
    if (Array.isArray(ans)) ans = ans.join(', ');
    fields[fieldName] = ans === undefined || ans === null ? '' : String(ans);
  });

  // 5. Create record in Airtable
  const createRes = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      records: [
        { fields }
      ]
    })
  });

  const resJson = await createRes.json();
  if (resJson.error) {
    console.error("Airtable Create Record Error:", resJson);
    return false;
  }

  return createRes.ok;
}
