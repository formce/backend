import { Hono } from 'hono';
import { Database } from "bun:sqlite";
import { authMiddleware } from '../middlewares';

// Ensure the db instance is created here or imported, standardizing on a new instance based on index.ts
const db = new Database("src/db/formce.db");

export const googleIntegrations = new Hono<{ Variables: { userId: number } }>();

// These should normally come from process.env, defining fallback for testability without ENV
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'your-client-id';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'your-client-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const REDIRECT_URI = `${BACKEND_URL}/api/integrations/google/callback`;

googleIntegrations.get('/auth', authMiddleware, (c) => {
  const userId = c.get('userId');
  const projectId = c.req.query('projectId');

  // We pass userId and projectId via state to recover it during callback
  const state = Buffer.from(JSON.stringify({ userId, projectId })).toString('base64');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.append('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'https://www.googleapis.com/auth/spreadsheets');
  authUrl.searchParams.append('access_type', 'offline');
  authUrl.searchParams.append('prompt', 'consent'); // Force consent to guarantee a refresh token
  authUrl.searchParams.append('state', state);

  return c.redirect(authUrl.toString());
});

googleIntegrations.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.text('Missing code or state', 400);
  }

  let userId: number;
  let projectId: string | undefined;
  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('ascii'));
    userId = decodedState.userId;
    projectId = decodedState.projectId;
  } catch (e) {
    return c.text('Invalid state', 400);
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return c.json(tokenData, 400);
  }

  const { refresh_token } = tokenData;

  if (refresh_token) {
    // Save to user
    const stmt = db.prepare('UPDATE users SET google_refresh_token = ? WHERE id = ?');
    stmt.run(refresh_token, userId);
  }

  if (projectId) {
    return c.redirect(`${FRONTEND_URL}/projects/${projectId}?googleConnected=true`);
  }
  return c.redirect(`${FRONTEND_URL}/projects/dashboard?googleConnected=true`);
});

googleIntegrations.post('/project/:id/spreadsheet', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('id');
  const { spreadsheetId } = await c.req.json();

  // Verify ownership
  const project = db.query("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId as number);
  if (!project) {
    return c.json({ error: "Project not found or unauthorized" }, 404);
  }

  const stmt = db.prepare('UPDATE projects SET google_spreadsheet_id = ? WHERE id = ?');
  stmt.run(spreadsheetId, projectId);

  return c.json({ success: true, message: 'Spreadsheet ID linked to project.' });
});

googleIntegrations.post('/project/:id/spreadsheet/create', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('id');

  // Verify ownership
  const project = db.query("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId as number) as any;
  if (!project) {
    return c.json({ error: "Project not found or unauthorized" }, 404);
  }

  // Get user's refresh token
  const user: any = db.query('SELECT google_refresh_token FROM users WHERE id = ?').get(userId as number);
  if (!user || !user.google_refresh_token) {
    return c.json({ error: "Google account not connected" }, 400);
  }

  // Get fresh access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: user.google_refresh_token,
      grant_type: 'refresh_token'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("Token exchange failed:", tokenData);
    return c.json({ error: "Failed to authenticate with Google", details: tokenData }, 500);
  }

  // Create Spreadsheet
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        title: `${project.title} - Responses`
      }
    })
  });

  const sheetData = await createRes.json();
  if (sheetData.error || !sheetData.spreadsheetId) {
    console.error("Google Sheets API failed:", sheetData);
    return c.json({ error: "Failed to create spreadsheet", details: sheetData }, 500);
  }

  // Save to database
  const stmt = db.prepare('UPDATE projects SET google_spreadsheet_id = ? WHERE id = ?');
  stmt.run(sheetData.spreadsheetId, projectId);

  return c.json({
    success: true,
    spreadsheetId: sheetData.spreadsheetId,
    spreadsheetUrl: sheetData.spreadsheetUrl
  });
});

// Helper function to be used during form submission
export async function appendRowToGoogleSheet(projectId: string | number, userId: number, spreadsheetId: string, responses: any) {
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

  const headers = ['Submitted At', ...questionsList.map(q => q.title)];
  const now = new Date().toLocaleString();

  const rowValues = [now];
  questionsList.forEach(q => {
    let ans = responses[`${q.pageId}_${q.questionId}`];
    if (Array.isArray(ans)) ans = ans.join(', ');
    rowValues.push(ans === undefined || ans === null ? '' : ans);
  });

  // 2. Get user's refresh token
  const user: any = db.query('SELECT google_refresh_token FROM users WHERE id = ?').get(userId);
  if (!user || !user.google_refresh_token) return false;

  // 2. Get fresh access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: user.google_refresh_token,
      grant_type: 'refresh_token'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return false;

  // 4. Check if we need to write headers
  const getRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:Z1`, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
  });
  const getData = await getRes.json();
  const hasHeaders = getData.values && getData.values.length > 0;

  const appendData = hasHeaders ? [rowValues] : [headers, rowValues];

  // 5. Append to Sheet
  const range = 'Sheet1'; // Default sheet name
  const sheetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      values: appendData
    })
  });

  return sheetRes.ok;
}
