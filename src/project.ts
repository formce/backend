import { Hono } from 'hono'
import { Database } from "bun:sqlite";
import { authMiddleware } from './middlewares';
import { Session } from "./auth";
import { appendRowToGoogleSheet } from './integrations/google';
import { appendRowToNotionDatabase } from './integrations/notion';
import { appendRowToAirtableTable } from './integrations/airtable';

const db = new Database("src/db/formce.db");

interface ProjectResponse {
  responses: string,
  submitted_at: string
}
interface PageQuestions {
  questions: string,
}

const project = new Hono()

// Public endpoint to get project and its pages (for respondents)
project.get("/:projectId/public", async (c) => {
  const { projectId } = c.req.param()
  const p = await db.query(`
    SELECT p.id, p.title, p.description, p.success_title, p.success_message, p.custom_css, p.background_color, p.brand_logo_url, p.form_type_title, u.email as creator_email
    FROM projects p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(projectId)

  if (!p) {
    return c.json({ message: 'Project not found' }, 404)
  }

  const pages = await db.query(`
    SELECT id, title, description, questions, logic
    FROM pages
    WHERE project_id = ?
    ORDER BY order_index ASC, created_at ASC
  `).all(projectId)

  return c.json({
    project: p, pages: pages.map(page => ({
      ...(page as Record<string, unknown>),
      questions: JSON.parse((page as any).questions),
      logic: JSON.parse((page as any).logic || '[]')
    }))
  })
})

// Public endpoint to submit a response
project.post("/:projectId/responses", async (c) => {
  const { projectId } = c.req.param()
  const formData = await c.req.json()
  const { responses } = formData
  const responsesStr = JSON.stringify(responses)
  await db.run(`
    INSERT INTO project_responses (project_id, responses)
    VALUES (?, ?)
  `, [projectId, responsesStr])

  // Process Integrations in the background
  const p = await db.query(`SELECT user_id, google_spreadsheet_id, notion_database_id, airtable_base_id, airtable_table_name FROM projects WHERE id = ?`).get(projectId) as any;
  if (p && p.google_spreadsheet_id) {
    appendRowToGoogleSheet(projectId, p.user_id, p.google_spreadsheet_id, responses).catch(err => {
      console.error("Failed to append to Google Sheets:", err);
    });
  }

  if (p && p.notion_database_id) {
    appendRowToNotionDatabase(projectId, p.user_id, p.notion_database_id, responses).catch(err => {
      console.error("Failed to append to Notion Database:", err);
    });
  }

  if (p && p.airtable_base_id && p.airtable_table_name) {
    appendRowToAirtableTable(projectId, p.user_id, p.airtable_base_id, p.airtable_table_name, responses).catch(err => {
      console.error("Failed to append to Airtable:", err);
    });
  }

  return c.json({ message: 'Project responses submitted successfully' })
})

// Protected routes
project.use(authMiddleware)

// List all projects
project.get('/', async (c) => {
  const token = c.req.header('Authorization')
  const session = await db.query(`
    SELECT * FROM sessions WHERE token = ?
  `).get(token as string)

  if (!session) { return c.json({ message: 'Invalid token' }, 401) }

  const projects = await db.query(`
    SELECT p.id, p.title, p.description, p.created_at as createdAt
    FROM projects p
    WHERE p.user_id = ?
  `).all((session as Session).user_id)

  return c.json({ projects })
})

// Create a new project
project.post('/', async (c) => {
  const formData = await c.req.json()
  const { title, description } = formData
  const token = c.req.header('Authorization')
  const session = await db.query(`
    SELECT * FROM sessions WHERE token = ?
  `).get(token as string)

  if (!session) { return c.json({ message: 'Invalid token' }, 401) }

  const data = await db.run(`
    INSERT INTO projects (user_id, title, description)
    VALUES (?, ?, ?)
  `, [(session as Session).user_id, title, description])

  const projectId = data.lastInsertRowid

  // Automatically create a default first page
  await db.run(`
    INSERT INTO pages (project_id, title, description, questions, order_index, logic)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [projectId, 'Page 1', '', '[]', 0, '[]'])

  return c.json({ message: 'Project created successfully', projectId })
})

// Get a specific project and its pages
project.get("/:projectId", async (c) => {
  const { projectId } = c.req.param()
  const token = c.req.header('Authorization')
  const session = await db.query(`SELECT * FROM sessions WHERE token = ?`).get(token as string) as Session;

  const p = await db.query(`
    SELECT p.id, p.title, p.description, p.created_at as createdAt, p.google_spreadsheet_id, p.success_title, p.success_message, p.custom_css, p.background_color, p.brand_logo_url, p.form_type_title, p.notion_database_id, p.airtable_base_id, p.airtable_table_name, p.google_drive_folder_id
    FROM projects p
    WHERE p.id = ? AND p.user_id = ?
  `).get(projectId, session.user_id)

  if (!p) { return c.json({ message: 'Project not found' }, 404) }

  const pages = await db.query(`
    SELECT id, title, description, questions, created_at as createdAt, logic
    FROM pages
    WHERE project_id = ?
    ORDER BY order_index ASC, created_at ASC
  `).all(projectId)

  const userId = (c.get as any)('userId');
  const usr = await db.query('SELECT google_refresh_token FROM users WHERE id = ?').get(userId as number) as any;
  const isGoogleConnected = !!(usr && usr.google_refresh_token);

  return c.json({
    project: p,
    isGoogleConnected,
    pages: (pages as any[]).map(pg => ({
      ...pg,
      questions: JSON.parse(pg.questions || '[]'),
      logic: JSON.parse(pg.logic || '[]')
    }))
  })
})

// Delete a specific project
project.delete("/:projectId", async (c) => {
  const { projectId } = c.req.param()
  // Ensure we delete rows that belong to this project
  await db.run(`DELETE FROM pages WHERE project_id = ?`, [projectId])
  await db.run(`DELETE FROM project_responses WHERE project_id = ?`, [projectId])
  await db.run(`DELETE FROM projects WHERE id = ?`, [projectId])
  return c.json({ message: 'Project deleted successfully' })
})

// Create a new page in a project
project.post("/:projectId/pages", async (c) => {
  const { projectId } = c.req.param()
  const formData = await c.req.json()
  const { title, description } = formData

  // Get the current max order_index for this project
  const maxOrderResult = await db.query(`
    SELECT MAX(order_index) as max_index
    FROM pages
    WHERE project_id = ?
  `).get(projectId) as any;
  const nextOrderIndex = (maxOrderResult.max_index ?? -1) + 1;

  const data = await db.run(`
    INSERT INTO pages (project_id, title, description, questions, order_index, logic)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [projectId, title || 'New Page', description || '', '[]', nextOrderIndex, '[]'])

  return c.json({ message: 'Page created successfully', pageId: data.lastInsertRowid })
})

// Reorder pages in a project
project.put("/:projectId/pages/reorder", async (c) => {
  const { projectId } = c.req.param();
  const { pageIds } = await c.req.json(); // Expected: an array of page IDs in their new order

  const updateStmt = db.prepare(`
        UPDATE pages
        SET order_index = ?
        WHERE id = ? AND project_id = ?
    `);

  const transaction = db.transaction(() => {
    pageIds.forEach((id: number, index: number) => {
      updateStmt.run(index, id, projectId);
    });
  });

  transaction();

  return c.json({ message: 'Pages reordered successfully' });
});

// Update an existing page
project.put("/:projectId/pages/:pageId", async (c) => {
  const { pageId } = c.req.param()
  const formData = await c.req.json()
  const { title, description } = formData
  await db.run(`
      UPDATE pages
      SET title = ?, description = ?
      WHERE id = ?
    `, [title, description, pageId])
  return c.json({ message: 'Page details updated successfully' })
})

// Update project settings
project.put("/:projectId/settings", async (c) => {
  const { projectId } = c.req.param();
  const formData = await c.req.json();
  const { success_title, success_message, custom_css, background_color, brand_logo_url, form_type_title } = formData;

  await db.run(`
      UPDATE projects
      SET success_title = ?, success_message = ?, custom_css = ?, background_color = ?, brand_logo_url = ?, form_type_title = ?
      WHERE id = ?
    `, [success_title, success_message, custom_css, background_color, brand_logo_url, form_type_title, projectId])
  return c.json({ message: 'Project settings updated successfully' })
})

// Get a specific page's details (for editing)
project.get("/:projectId/pages/:pageId", async (c) => {
  const { pageId } = c.req.param()
  const page = await db.query(`
    SELECT id, title, description, questions, logic
    FROM pages
    WHERE id = ?
  `).get(pageId)

  if (!page) { return c.json({ message: 'Page not found' }, 404) }

  return c.json({
    page: {
      id: (page as any).id,
      title: (page as any).title,
      description: (page as any).description,
      questions: JSON.parse((page as any).questions),
      logic: JSON.parse((page as any).logic || '[]')
    }
  })
})

// Delete a specific page (for editing)
project.delete("/:projectId/pages/:pageId", async (c) => {
  const { pageId } = c.req.param()
  await db.run(`DELETE FROM pages WHERE id = ?`, [pageId])
  return c.json({ message: 'Page deleted successfully' })
})

// Update a page's questions
project.post("/:projectId/pages/:pageId/questions", async (c) => {
  const { pageId } = c.req.param()
  const formData = await c.req.json()
  const { questions } = formData
  const questionsStr = JSON.stringify(questions)

  await db.run(`
    UPDATE pages
    SET questions = ?
    WHERE id = ?
  `, [questionsStr, pageId])

  return c.json({ message: 'Page questions updated successfully' })
})

// Update a page's logic
project.post("/:projectId/pages/:pageId/logic", async (c) => {
  const { pageId } = c.req.param()
  const formData = await c.req.json()
  const { logic } = formData
  const logicStr = JSON.stringify(logic)

  await db.run(`
    UPDATE pages
    SET logic = ?
    WHERE id = ?
  `, [logicStr, pageId])

  return c.json({ message: 'Page logic updated successfully' })
})


// Get all responses for a project
project.get("/:projectId/responses", async (c) => {
  const { projectId } = c.req.param()

  const rows = await db.query(`
    SELECT fr.id, fr.responses, fr.submitted_at
    FROM project_responses fr
    WHERE fr.project_id = ?
  `).all(projectId)

  const responses = rows.map((row) => {
    const r = row as ProjectResponse
    return {
      answers: JSON.parse(r.responses),
      submittedAt: r.submitted_at
    }
  })

  // We should also return the project structure so the frontend knows what to map it to
  const p = await db.query(`SELECT title FROM projects WHERE id = ?`).get(projectId)

  const pages = await db.query(`
    SELECT id, title, questions, logic
    FROM pages
    WHERE project_id = ?
    ORDER BY order_index ASC, created_at ASC
  `).all(projectId)

  return c.json({
    responses,
    project: p,
    pages: pages.map(page => ({
      ...(page as Record<string, unknown>),
      questions: JSON.parse((page as any).questions),
      logic: JSON.parse((page as any).logic || '[]')
    }))
  })
})

export default project
