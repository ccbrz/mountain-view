import { getDB } from '../db'
import { PersistentVectorStore } from './vectorstore'

/** SQLite 自带的中文 trigram 索引；正文变更与索引更新在同一事务。 */
export function initChapterSearch() {
  const db = getDB()
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'novel_chapter_search'").get()) return
  db.transaction(() => {
    db.exec(`CREATE VIRTUAL TABLE novel_chapter_search USING fts5(content, content='novel_chapters', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER chapter_search_insert AFTER INSERT ON novel_chapters BEGIN
        INSERT INTO novel_chapter_search(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER chapter_search_delete AFTER DELETE ON novel_chapters BEGIN
        INSERT INTO novel_chapter_search(novel_chapter_search, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER chapter_search_update AFTER UPDATE OF content ON novel_chapters BEGIN
        INSERT INTO novel_chapter_search(novel_chapter_search, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO novel_chapter_search(rowid, content) VALUES (new.id, new.content);
      END;
      INSERT INTO novel_chapter_search(novel_chapter_search) VALUES ('rebuild');`)
  })()
}

export interface Evidence { chapter: number; text: string }

export function searchChapterText(novelId: number, before: number, query: string): Evidence[] {
  const db = getDB()
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query)].filter(w => w.isWordLike).map(w => w.segment)
  const terms = [...new Set(words.flatMap((w, i) => [w, w + (words[i + 1] || '')]))]
    .filter(w => w.length >= 2 && w.length <= 20).slice(0, 100)
  const long = terms.filter(w => w.length >= 3)
  let rows: any[] = long.length ? db.prepare(`SELECT c.chapter_number, c.content FROM novel_chapter_search
    JOIN novel_chapters c ON c.id = novel_chapter_search.rowid
    WHERE novel_chapter_search MATCH ? AND c.novel_id = ? AND c.chapter_number < ? AND c.status = 'finalized'
    ORDER BY rank, c.chapter_number LIMIT 24`).all(long.map(w => `"${w.replace(/"/g, '""')}"`).join(' OR '), novelId, before) : []
  // ponytail: 两字名称不进 trigram；只在无命中时扫描本书有效前缀，规模上来再单独做二元索引。
  if (!rows.length && terms.length) {
    rows = db.prepare(`SELECT chapter_number, content FROM novel_chapters WHERE novel_id = ? AND chapter_number < ?
      AND status = 'finalized' AND (${terms.slice(0, 12).map(() => 'instr(content, ?) > 0').join(' OR ')}) ORDER BY chapter_number LIMIT 24`)
      .all(novelId, before, ...terms.slice(0, 12))
  }
  return rows.slice(0, 6).map(row => {
    // 在命中密集的位置取原文窗口，不让章首的寒暄挤掉真正的证据。
    const positions = terms.flatMap(term => {
      const found: number[] = []
      for (let p = row.content.indexOf(term); p >= 0 && found.length < 20; p = row.content.indexOf(term, p + term.length)) found.push(p)
      return found
    })
    const best = positions.sort((a, b) => {
      const score = (p: number) => terms.reduce((n, t) => n + (row.content.slice(Math.max(0, p - 250), p + 500).includes(t) ? t.length : 0), 0)
      return score(b) - score(a) || a - b
    })[0] || 0
    return { chapter: row.chapter_number, text: row.content.slice(Math.max(0, best - 250), best + 500) }
  })
}

export async function chapterEvidence(novel: any, before: number, query: string): Promise<{ text: string; warning: string }> {
  const evidence = searchChapterText(novel.id, before, query)
  let warning = ''
  if (novel.embedding_config) {
    const vs = new PersistentVectorStore(novel.id)
    vs.setEmbeddingConfig(novel.embedding_config)
    try {
      const results = await vs.search(query, 3, m => Number(m.chapter) < before)
      for (const r of results) if (!evidence.some(e => e.chapter === Number(r.metadata.chapter) && e.text.includes(r.text))) {
        evidence.push({ chapter: Number(r.metadata.chapter), text: r.text })
      }
    } catch (e: any) { warning = `语义检索不可用，已使用本地原文检索：${e.message}` }
  }
  return { warning, text: '\n=== 历史原文证据（按来源章号引用；旧状态以最新有效状态为准）===\n' +
    (evidence.length ? evidence.slice(0, 8).map(e => `[第${e.chapter}章原文]\n${e.text}`).join('\n\n') : '未找到相关原文；不得补造过去发生的细节。') +
    '\n回忆中的数量、颜色、物品、原话必须有来源。检索未找到不代表从未发生；缺证据时写不确定或省略该细节。原文和角色档案供作者参考，不等于所有角色知情。\n' }
}
