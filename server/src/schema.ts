import { getDB } from './db'
import { initChapterSearch } from './llm/chapter-evidence'

export function initTable(name: string, columns: string) {
  getDB().exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns})`)
}

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

    -- 进入第 N 章时的摘要和角色状态，见 llm/doc-snapshots.ts
    CREATE TABLE IF NOT EXISTS novel_doc_snapshots (
      novel_id INTEGER NOT NULL,
      chapter_number INTEGER NOT NULL,
      doc_type TEXT NOT NULL,
      content TEXT DEFAULT '',
      PRIMARY KEY (novel_id, chapter_number, doc_type)
    );

    CREATE TABLE IF NOT EXISTS novel_memory_reviews (
      chapter_id INTEGER PRIMARY KEY REFERENCES novel_chapters(id) ON DELETE CASCADE,
      review_id TEXT NOT NULL,
      context_revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      accepted_content TEXT,
      reviewed_by TEXT,
      reviewed_at DATETIME
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
    CREATE INDEX IF NOT EXISTS idx_outline_revisions ON chapter_outline_revisions(chapter_id, id DESC);
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
  addCol('style_reference', "TEXT DEFAULT ''")
  addCol('style_guide', "TEXT DEFAULT ''")
  const migrateContext = !hasCol('context_revision')

  // migrate novel_chapters table
  const chapterCols = db.prepare("PRAGMA table_info('novel_chapters')").all() as { name: string }[]
  const hasChapterCol = (name: string) => chapterCols.some((c) => c.name === name)
  const addChapterCol = (name: string, def: string) => {
    if (!hasChapterCol(name)) {
      db.exec(`ALTER TABLE novel_chapters ADD COLUMN ${name} ${def}`)
    }
  }
  addChapterCol('outline', "TEXT DEFAULT ''")
  addChapterCol('outline_revision', 'INTEGER NOT NULL DEFAULT 0')
  db.transaction(() => {
    addCol('context_revision', 'INTEGER NOT NULL DEFAULT 0')
    addChapterCol('index_status', "TEXT NOT NULL DEFAULT 'pending'")
    const migrateSummaries = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'novel_chapter_summaries'").get()
    db.exec(`CREATE TABLE IF NOT EXISTS novel_chapter_summaries (
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      chapter_number INTEGER NOT NULL CHECK (chapter_number > 0),
      content TEXT NOT NULL,
      PRIMARY KEY (novel_id, chapter_number)
    )`)

    // 旧快照没有版本依据，不能证明与正文一致。首次升级保留全部正文，要求顺序重新定稿。
    if (migrateContext) {
      db.exec("DELETE FROM novel_doc_snapshots; DELETE FROM novel_chapter_summaries; DELETE FROM novel_memory_reviews; UPDATE novel_docs SET content = '' WHERE doc_type = 'progress';")
      db.exec("UPDATE novel_chapters SET status = CASE WHEN length(trim(content)) > 0 THEN 'needs_review' ELSE 'draft' END, index_status = 'pending';")
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_embeddings'").get()) {
        db.exec('DELETE FROM vector_embeddings')
      }
    } else if (migrateSummaries) {
      // 已有版本保护的快照无损拆分，不要求用户重新定稿。逐条读取，避免整库 JSON 同时驻留内存。
      const keys = db.prepare("SELECT novel_id, chapter_number FROM novel_doc_snapshots WHERE doc_type = 'progress' ORDER BY novel_id, chapter_number").all() as any[]
      const read = db.prepare("SELECT content FROM novel_doc_snapshots WHERE novel_id = ? AND chapter_number = ? AND doc_type = 'progress'")
      const insert = db.prepare('INSERT INTO novel_chapter_summaries (novel_id, chapter_number, content) VALUES (?, ?, ?)')
      const update = db.prepare("UPDATE novel_doc_snapshots SET content = ? WHERE novel_id = ? AND chapter_number = ? AND doc_type = 'progress'")
      for (const key of keys) {
        const { summaries, ...state } = JSON.parse((read.get(key.novel_id, key.chapter_number) as any).content)
        const summary = Array.isArray(summaries) && summaries.find((s: any) => s.chapter === state.chapter)
        if (state.chapter !== key.chapter_number - 1 || typeof summary?.text !== 'string' || !summary.text.trim()) {
          throw new Error(`小说 ${key.novel_id} 第 ${key.chapter_number} 章进度无法拆分摘要，迁移已回滚`)
        }
        insert.run(key.novel_id, state.chapter, summary.text)
        update.run(JSON.stringify(state), key.novel_id, key.chapter_number)
      }
      db.exec("DELETE FROM novel_docs WHERE doc_type = 'progress'")
    }
  })()

  // unique index on novel_docs
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_docs_type ON novel_docs(novel_id, doc_type);
    CREATE INDEX IF NOT EXISTS idx_novel_chapters_novel ON novel_chapters(novel_id, chapter_number);
    CREATE INDEX IF NOT EXISTS idx_chapter_revisions ON chapter_revisions(chapter_id, created_at DESC);
  `)
  initChapterSearch()
}
