import { Hono } from 'hono'
import { Database } from "bun:sqlite";
import { authMiddleware } from './middlewares';
import { Session } from "./auth";

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
    SELECT p.id, p.title, p.description
    FROM projects p
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

  const p = await db.query(`
    SELECT p.id, p.title, p.description, p.created_at as createdAt
    FROM projects p
    WHERE p.id = ?
  `).get(projectId)

  if (!p) { return c.json({ message: 'Project not found' }, 404) }

  const pages = await db.query(`
    SELECT id, title, description, questions, created_at as createdAt, logic
    FROM pages
    WHERE project_id = ?
    ORDER BY order_index ASC, created_at ASC
  `).all(projectId)

  return c.json({
    project: p,
    pages: (pages as any[]).map(pg => ({
      ...pg,
      questions: JSON.parse(pg.questions || '[]'),
      logic: JSON.parse(pg.logic || '[]')
    }))
  })
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
