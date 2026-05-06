import { Hono } from 'hono';
import { Database } from "bun:sqlite";
import { authMiddleware } from '../middlewares';

const db = new Database("src/db/formce.db");
export const notionIntegrations = new Hono<{ Variables: { userId: number } }>();

const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID || 'your-client-id';
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET || 'your-client-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const REDIRECT_URI = `${BACKEND_URL}/api/integrations/notion/callback`;

notionIntegrations.get('/auth', authMiddleware, (c) => {
  const userId = c.get('userId');
  const projectId = c.req.query('projectId');
  const state = Buffer.from(JSON.stringify({ userId, projectId })).toString('base64');

  const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.append('client_id', NOTION_CLIENT_ID);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('owner', 'user');
  authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.append('state', state);

  return c.redirect(authUrl.toString());
});

notionIntegrations.get('/callback', async (c) => {
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

  // Token exchange
  const credentials = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) return c.json(tokenData, 400);

  if (tokenData.access_token) {
    const stmt = db.prepare('UPDATE users SET notion_access_token = ?, notion_workspace_id = ? WHERE id = ?');
    stmt.run(tokenData.access_token, tokenData.workspace_id, userId);
  }

  if (projectId) {
    return c.redirect(`${FRONTEND_URL}/projects/${projectId}?notionConnected=true`);
  }
  return c.redirect(`${FRONTEND_URL}/projects/dashboard?notionConnected=true`);
});

notionIntegrations.post('/project/:id/database', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('id');
  const { databaseId } = await c.req.json();

  const project = db.query("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId as number);
  if (!project) return c.json({ error: "Project not found or unauthorized" }, 404);

  const stmt = db.prepare('UPDATE projects SET notion_database_id = ? WHERE id = ?');
  stmt.run(databaseId, projectId);

  return c.json({ success: true, message: 'Notion Database ID linked to project.' });
});

notionIntegrations.post('/project/:id/database/create', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('id');

  const project: any = db.query("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId as number);
  const user: any = db.query("SELECT notion_access_token FROM users WHERE id = ?").get(userId as number);

  if (!project || !user || !user.notion_access_token) {
    return c.json({ error: "Project or Notion Connection not found" }, 404);
  }

  try {
    const searchRes = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${user.notion_access_token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filter: { value: 'page', property: 'object' } })
    });
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      return c.json({ error: "No accessible parent page found! Please manually share an existing Notion page with your formce integration during oauth so Formce can create databases under it." }, 400);
    }
    const parentPageId = searchData.results[0].id;

    const dbRes = await fetch('https://api.notion.com/v1/databases', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${user.notion_access_token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: `Formce: ${project.title}` } }],
        properties: {
          "Name": { title: {} }
        }
      })
    });

    const dbData = await dbRes.json();
    if (dbData.error) {
      console.error("Notion DB Creation Error:", dbData);
      return c.json(dbData, 400);
    }

    const databaseId = dbData.id;
    const stmt = db.prepare('UPDATE projects SET notion_database_id = ? WHERE id = ?');
    stmt.run(databaseId, projectId);

    return c.json({ success: true, databaseId });
  } catch (err: any) {
    console.error("Error creating Notion database:", err);
    return c.json({ error: 'Failed to create Notion database', details: err.message }, 500);
  }
});

// Helper function to be used during form submission
export async function appendRowToNotionDatabase(projectId: string | number, userId: number, databaseId: string, responses: any) {
  // 1. Fetch questions to map order
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

  const now = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // 2. Get user's notion token
  const user: any = db.query('SELECT notion_access_token FROM users WHERE id = ?').get(userId);
  if (!user || !user.notion_access_token) return false;

  // 3. Fetch current database schema to identify missing columns
  const dbRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${user.notion_access_token}`,
      'Notion-Version': '2022-06-28'
    }
  });

  const dbData = await dbRes.json();
  if (dbData.error) {
    console.error("Notion Fetch Schema Error:", dbData);
    return false;
  }

  const existingPropNames = Object.keys(dbData.properties);
  const newPropsToPatch: any = {};
  let needsPatch = false;

  questionsList.forEach(q => {
    const propName = String(q.title).trim();
    if (propName && !existingPropNames.includes(propName)) {
      newPropsToPatch[propName] = { rich_text: {} };
      needsPatch = true;
    }
  });

  // 4. Temporarily PATCH Database schema to inject columns natively!
  if (needsPatch) {
    const patchRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${user.notion_access_token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ properties: newPropsToPatch })
    });
    const patchData = await patchRes.json();
    if (patchData.error) {
      console.error("Notion Patch Schema Error:", patchData);
      // continue anyway, maybe it just drops the fields
    }
  }

  // 5. Build dynamic Property Row Record
  const pageProperties: any = {
    "Name": {
      title: [
        { text: { content: `Response - ${now}` } }
      ]
    }
  };

  questionsList.forEach(q => {
    const propName = String(q.title).trim();
    if (!propName) return;

    let ans = responses[`${q.pageId}_${q.questionId}`];
    if (Array.isArray(ans)) ans = ans.join(', ');
    const displayAns = ans === undefined || ans === null ? '' : String(ans);

    // Limit to 2000 chars to satisfy Notion length bounds
    pageProperties[propName] = {
      rich_text: [
        { text: { content: displayAns.substring(0, 2000) } }
      ]
    };
  });

  // 6. Make Notion API call
  const postRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${user.notion_access_token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: pageProperties
    })
  });

  const resJson = await postRes.json();
  if (resJson.error) {
    console.error("Notion appendRow Error:", resJson);
    return false;
  }

  return postRes.ok;
}
