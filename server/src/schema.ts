import { getDB } from './db'

export function initTable(name: string, columns: string) {
  getDB().exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns})`)
}

export function initSchema() {
  getDB().exec(`
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
      creator_username TEXT NOT NULL,
      genre TEXT DEFAULT '',
      word_number INTEGER DEFAULT 2000,
      guidance TEXT DEFAULT '',
      style_guide TEXT DEFAULT '',
      context_revision INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS novel_chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      novel_id INTEGER NOT NULL,
      chapter_number INTEGER NOT NULL,
      title TEXT DEFAULT '',
      outline TEXT DEFAULT '',
      outline_revision INTEGER NOT NULL DEFAULT 0,
      content TEXT DEFAULT '',
      author_note TEXT NOT NULL DEFAULT '',
      writer_last_context TEXT NOT NULL DEFAULT '',
      writer_incomplete INTEGER NOT NULL DEFAULT 0,
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

    -- 每次修订前先把当前正文压栈，保证任何一轮重写都能对比和回退
    CREATE TABLE IF NOT EXISTS chapter_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chapter_outline_reviews (
      chapter_id INTEGER PRIMARY KEY REFERENCES novel_chapters(id) ON DELETE CASCADE,
      review_id TEXT NOT NULL,
      outline_revision INTEGER NOT NULL,
      context_revision INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chapter_outline_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
      outline TEXT NOT NULL,
      note TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS writer_artifacts (
      id TEXT PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS writer_memory_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      chapter_number INTEGER, title TEXT NOT NULL DEFAULT '', memory TEXT NOT NULL,
      kind TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      memory_through_chapter INTEGER, source_digest TEXT NOT NULL DEFAULT '', invalidated_at TEXT NOT NULL DEFAULT ''
    );

    -- Lorebook 人物形象：按条目 ID 只保留最新一张，随作品删除
    CREATE TABLE IF NOT EXISTS lore_portraits (
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      image BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (novel_id, entry_id)
    );

    -- 章节背景图：每章只保留最新一张，随章节删除
    CREATE TABLE IF NOT EXISTS chapter_backgrounds (
      chapter_id INTEGER PRIMARY KEY REFERENCES novel_chapters(id) ON DELETE CASCADE,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL DEFAULT '',
      image BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_docs_type ON novel_docs(novel_id, doc_type);
    CREATE INDEX IF NOT EXISTS idx_novel_chapters_novel ON novel_chapters(novel_id, chapter_number);
    CREATE INDEX IF NOT EXISTS idx_chapter_revisions ON chapter_revisions(chapter_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outline_revisions ON chapter_outline_revisions(chapter_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_writer_artifacts ON writer_artifacts(chapter_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_writer_memory_history ON writer_memory_history(novel_id, id DESC);
  `)
}
