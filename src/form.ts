import { Hono } from 'hono'
import { Database } from "bun:sqlite";
import {authMiddleware} from './middlewares';
import { Session } from "./auth";

const db = new Database("src/db/formce.db");

interface FormResponse {
    responses: string,
    submitted_at: string
  }
interface FormQuestions {
  questions: string,
  options: string
}

const form = new Hono()

form.use(authMiddleware)

form.post('/', async (c) => {
  const formData = await c.req.json()
  const { title, description } = formData
  const token = c.req.header('Authorization')

  const session = await db.query(`
    SELECT * FROM sessions WHERE token = ?
  `).get(token as string)

  if (!session) {
    return c.json({ message: 'Invalid token' }, 401)
  }

  const data = await db.run(`
    INSERT INTO forms (user_id, title, description)
    VALUES (?, ?, ?)
  `, [(session as Session).user_id, title, description])
  const formId = data.lastInsertRowid
  await db.run(`
    INSERT INTO form_questions (form_id, questions, options)
    VALUES (?, ?, ?)
  `, [formId, '[]', '[]'])
  return c.json({ message: 'Form submitted successfully', formId })
})

form.post("/:formId/add", async (c) => {
  const { formId } = c.req.param()
  const formData = await c.req.json()
  const { questions, options } = formData
  const questionsStr = JSON.stringify(questions)
  const optionsStr = JSON.stringify(options)
  await db.run(`
    UPDATE form_questions
    SET questions = ?, options = ?
    WHERE form_id = ?
  `, [questionsStr, optionsStr, formId])
  return c.json({ message: 'Form questions added successfully' })
})

form.get("/:formId", async (c) => {
  const { formId } = c.req.param()
  const row = await db.query(`
    SELECT fq.questions, fq.options
    FROM form_questions fq
    WHERE fq.form_id = ?
  `).get(formId)
  if (!row) {
    return c.json({ message: 'Form not found' }, 404)
  }
  const questions = JSON.parse((row as FormQuestions).questions)
  const options = JSON.parse((row as FormQuestions).options)
  return c.json({ questions, options })
})

form.post("/:formId", async (c) => {
  const { formId } = c.req.param()
  const formData = await c.req.json()
  const { responses } = formData
  const responsesStr = JSON.stringify(responses)
  await db.run(`
    INSERT INTO form_responses (form_id, responses)
    VALUES (?, ?)
  `, [formId, responsesStr])
  return c.json({ message: 'Form responses submitted successfully' })
})

form.get("/:formId/responses", async (c) => {

  const { formId } = c.req.param()
  const questionRow = await db.query(`
    SELECT fq.questions, fq.options
    FROM form_questions fq
    WHERE fq.form_id = ?
  `).get(formId)
  if (!questionRow) {
    return c.json({ message: 'Form not found' }, 404)
  }
  const questions = JSON.parse((questionRow as FormQuestions).questions)
  const options = JSON.parse((questionRow as FormQuestions).options)
  const rows = await db.query(`
    SELECT fr.id, fr.responses, fr.submitted_at
    FROM form_responses fr
    WHERE fr.form_id = ?
  `).all(formId)
  const responses = rows.map((row) => {
    const r = row as FormResponse
    return {
      responses: JSON.parse(r.responses),
      submitted_at: r.submitted_at
    }
  })
  return c.json({ responses, questions, options })
})

export default form
