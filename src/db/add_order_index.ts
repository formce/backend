import { Database } from "bun:sqlite";

const db = new Database("src/db/formce.db");

try {
  // Check if column exists, if not, add it
  const columnsInfo = db.query(`PRAGMA table_info(pages)`).all();
  const hasOrderIndex = columnsInfo.some((col: any) => col.name === 'order_index');

  if (!hasOrderIndex) {
    console.log("Adding 'order_index' column to 'pages' table...");
    db.run(`ALTER TABLE pages ADD COLUMN order_index INTEGER DEFAULT 0;`);
    console.log("'order_index' column added successfully.");

    // Set a baseline order for existing pages
    console.log("Initializing baseline ordering...");
    const pages = db.query(`SELECT id, project_id FROM pages ORDER BY created_at ASC`).all() as any[];

    // Group pages by project to set progressive indexes
    const projectCounters: Record<number, number> = {};
    const updateStmt = db.prepare(`UPDATE pages SET order_index = ? WHERE id = ?`);

    const transaction = db.transaction(() => {
      for (const page of pages) {
        const pId = page.project_id;
        if (projectCounters[pId] === undefined) {
          projectCounters[pId] = 0;
        }
        updateStmt.run(projectCounters[pId], page.id);
        projectCounters[pId]++;
      }
    });

    transaction();
    console.log("Baseline ordering initialized.");
  } else {
    console.log("'order_index' column already exists on 'pages'.");
  }
} catch (error) {
  console.error("Migration failed:", error);
}

console.log("Migration complete.");
