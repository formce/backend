import { Database } from "bun:sqlite";

const db = new Database("src/db/formce.db");

try {
  // Check if column exists, if not, add it
  const columnsInfo = db.query(`PRAGMA table_info(pages)`).all();
  const hasLogicColumn = columnsInfo.some((col: any) => col.name === 'logic');

  if (!hasLogicColumn) {
    console.log("Adding 'logic' column to 'pages' table...");
    db.run(`ALTER TABLE pages ADD COLUMN logic TEXT DEFAULT '[]';`);
    console.log("'logic' column added successfully.");
  } else {
    console.log("'logic' column already exists on 'pages'.");
  }
} catch (error) {
  console.error("Migration failed:", error);
}

console.log("Migration complete.");
