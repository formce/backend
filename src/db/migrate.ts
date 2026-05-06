import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

const dbPath = "src/db/formce.db";

if (existsSync(dbPath)) {
  unlinkSync(dbPath);
  console.log("Existing database deleted.");
}

const db = new Database(dbPath);

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    google_refresh_token TEXT,
    notion_access_token TEXT,
    notion_workspace_id TEXT,
    airtable_refresh_token TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+5 hours', '30 minutes'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT (datetime('now', '+5 hours', '30 minutes')),
    expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+5 hours', '30 minutes', '+7 days')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    success_title TEXT DEFAULT 'Thank you!',
    success_message TEXT DEFAULT 'Your response has been successfully recorded.',
    custom_css TEXT DEFAULT '',
    background_color TEXT DEFAULT '#ffffff',
    brand_logo_url TEXT DEFAULT '',
    form_type_title TEXT DEFAULT 'Public Survey',
    google_spreadsheet_id TEXT,
    google_drive_folder_id TEXT,
    notion_database_id TEXT,
    airtable_base_id TEXT,
    airtable_table_name TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+5 hours', '30 minutes')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    questions TEXT NOT NULL,
    logic TEXT DEFAULT '[]',
    order_index INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', '+5 hours', '30 minutes')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS project_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    responses TEXT NOT NULL,
    submitted_at DATETIME DEFAULT (datetime('now', '+5 hours', '30 minutes')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  )
`);

console.log("Database migrations completed.");
