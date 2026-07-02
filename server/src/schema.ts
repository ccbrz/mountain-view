import { getDB } from './db'

export function initSchema() {
  const db = getDB()

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      permissions TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS novels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      creator_username TEXT NOT NULL,
      genre TEXT DEFAULT '',
      num_chapters INTEGER DEFAULT 10,
      word_number INTEGER DEFAULT 2000,
      guidance TEXT DEFAULT '',
      status TEXT DEFAULT 'created',
      llm_config TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS novel_chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      novel_id INTEGER NOT NULL,
      chapter_number INTEGER NOT NULL,
      title TEXT DEFAULT '',
      outline TEXT DEFAULT '',
      content TEXT DEFAULT '',
      content_before_draft TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      word_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS novel_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      novel_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL,
      content TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS llm_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      interface_format TEXT DEFAULT 'OpenAI',
      base_url TEXT NOT NULL,
      model_name TEXT NOT NULL,
      api_key TEXT DEFAULT '',
      temperature REAL DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 4096,
      timeout INTEGER DEFAULT 600,
      created_by TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // migrate old novels table if columns missing
  const cols = db.prepare("PRAGMA table_info('novels')").all() as { name: string }[]
  const hasCol = (name: string) => cols.some((c) => c.name === name)
  const addCol = (name: string, def: string) => {
    if (!hasCol(name)) {
      db.exec(`ALTER TABLE novels ADD COLUMN ${name} ${def}`)
    }
  }
  addCol('genre', "TEXT DEFAULT ''")
  addCol('num_chapters', 'INTEGER DEFAULT 10')
  addCol('word_number', 'INTEGER DEFAULT 2000')
  addCol('guidance', "TEXT DEFAULT ''")
  addCol('status', "TEXT DEFAULT 'created'")
  addCol('llm_config', "TEXT DEFAULT ''")
  addCol('embedding_config', "TEXT DEFAULT ''")

  // migrate novel_chapters table
  const chapterCols = db.prepare("PRAGMA table_info('novel_chapters')").all() as { name: string }[]
  const hasChapterCol = (name: string) => chapterCols.some((c) => c.name === name)
  const addChapterCol = (name: string, def: string) => {
    if (!hasChapterCol(name)) {
      db.exec(`ALTER TABLE novel_chapters ADD COLUMN ${name} ${def}`)
    }
  }
  addChapterCol('outline', "TEXT DEFAULT ''")

  // unique index on novel_docs
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_docs_type ON novel_docs(novel_id, doc_type);
    CREATE INDEX IF NOT EXISTS idx_novel_chapters_novel ON novel_chapters(novel_id, chapter_number);
  `)
}
