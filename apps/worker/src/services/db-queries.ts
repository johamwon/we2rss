import {
  nowMs,
  toAccountDto,
  toAccountPublicDto,
  toArticleDto,
  toFeedDto,
} from '../db';
import type { AccountRow, ArticleRow, FeedRow } from '../db';
import { statusMap } from '../constants';

function buildNotInClause(values: string[]) {
  if (values.length === 0) {
    return { clause: '', params: [] as string[] };
  }

  const placeholders = values.map(() => '?').join(',');
  return {
    clause: ` AND id NOT IN (${placeholders})`,
    params: values,
  };
}

async function getCreatedAtCursor(
  db: D1Database,
  table: string,
  id: string,
): Promise<{ created_at: number } | null> {
  const row = await db
    .prepare(`SELECT created_at FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ created_at: number }>();
  return row ?? null;
}

async function getPublishTimeCursor(
  db: D1Database,
  id: string,
): Promise<{ publish_time: number } | null> {
  const row = await db
    .prepare(`SELECT publish_time FROM articles WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ publish_time: number }>();
  return row ?? null;
}

export async function listAccounts(
  db: D1Database,
  limit: number,
  cursor?: string | null,
) {
  let where = '';
  const params: unknown[] = [];

  if (cursor) {
    const cursorRow = await getCreatedAtCursor(db, 'accounts', cursor);
    if (cursorRow) {
      where =
        ' WHERE (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(cursorRow.created_at, cursorRow.created_at, cursor);
    }
  }

  const rows = await db
    .prepare(
      `SELECT id, name, status, token, pending_login_id, created_at, updated_at
       FROM accounts${where}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<AccountRow>();

  const items = rows.results.map((row) => toAccountPublicDto(row));
  let nextCursor: string | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return { items, nextCursor };
}

export async function listFeeds(
  db: D1Database,
  limit: number,
  cursor?: string | null,
) {
  let where = '';
  const params: unknown[] = [];

  if (cursor) {
    const cursorRow = await getCreatedAtCursor(db, 'feeds', cursor);
    if (cursorRow) {
      where =
        ' WHERE (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(cursorRow.created_at, cursorRow.created_at, cursor);
    }
  }

  const rows = await db
    .prepare(
      `SELECT id, mp_name, mp_cover, mp_intro, status, sync_time, update_time,
         has_history, created_at, updated_at
       FROM feeds${where}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<FeedRow>();

  const items = rows.results.map((row) => toFeedDto(row));
  let nextCursor: string | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return { items, nextCursor };
}

export async function listArticles(
  db: D1Database,
  limit: number,
  cursor?: string | null,
  mpId?: string | null,
) {
  let where = '';
  const params: unknown[] = [];

  if (mpId) {
    where = ' WHERE mp_id = ?';
    params.push(mpId);
  }

  if (cursor) {
    const cursorRow = await getPublishTimeCursor(db, cursor);
    if (cursorRow && cursorRow.publish_time !== undefined) {
      where +=
        (where ? ' AND' : ' WHERE') +
        ' (publish_time < ? OR (publish_time = ? AND id < ?))';
      params.push(cursorRow.publish_time, cursorRow.publish_time, cursor);
    }
  }

  const rows = await db
    .prepare(
      `SELECT id, mp_id, title, pic_url, publish_time, created_at, updated_at
       FROM articles${where}
       ORDER BY publish_time DESC, id DESC
       LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<ArticleRow>();

  const items = rows.results.map((row) => toArticleDto(row));
  let nextCursor: string | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return { items, nextCursor };
}

export async function getAccountById(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT id, token, name, status, pending_login_id, created_at, updated_at
       FROM accounts WHERE id = ?`,
    )
    .bind(id)
    .first<AccountRow>();
  return row ? toAccountDto(row) : null;
}

export async function upsertAccount(
  db: D1Database,
  input: { id: string; token: string; name: string; status: number },
) {
  const now = nowMs();
  await db
    .prepare(
      `INSERT INTO accounts (id, token, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         token = excluded.token,
         name = excluded.name,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .bind(input.id, input.token, input.name, input.status, now, now)
    .run();

  return getAccountById(db, input.id);
}

export async function updateAccount(
  db: D1Database,
  id: string,
  data: Partial<{ token: string; name: string; status: number; pendingLoginId: string | null }>,
) {
  const updates: string[] = [];
  const params: unknown[] = [];

  if (data.token !== undefined) {
    updates.push('token = ?');
    params.push(data.token);
  }
  if (data.name !== undefined) {
    updates.push('name = ?');
    params.push(data.name);
  }
  if (data.status !== undefined) {
    updates.push('status = ?');
    params.push(data.status);
  }
  if ('pendingLoginId' in data) {
    updates.push('pending_login_id = ?');
    params.push(data.pendingLoginId ?? null);
  }

  updates.push('updated_at = ?');
  params.push(nowMs());

  await db
    .prepare(
      `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`,
    )
    .bind(...params, id)
    .run();

  return getAccountById(db, id);
}

export async function deleteAccount(db: D1Database, id: string) {
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
}

export async function getFeedById(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT id, mp_name, mp_cover, mp_intro, status, sync_time, update_time,
         has_history, created_at, updated_at
       FROM feeds WHERE id = ?`,
    )
    .bind(id)
    .first<FeedRow>();
  return row ? toFeedDto(row) : null;
}

export async function upsertFeed(
  db: D1Database,
  input: {
    id: string;
    mpName: string;
    mpCover: string;
    mpIntro: string;
    syncTime: number;
    updateTime: number;
    status: number;
  },
) {
  const now = nowMs();
  await db
    .prepare(
      `INSERT INTO feeds (id, mp_name, mp_cover, mp_intro, status, sync_time,
         update_time, has_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         mp_name = excluded.mp_name,
         mp_cover = excluded.mp_cover,
         mp_intro = excluded.mp_intro,
         status = excluded.status,
         sync_time = excluded.sync_time,
         update_time = excluded.update_time,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.mpName,
      input.mpCover,
      input.mpIntro,
      input.status,
      input.syncTime,
      input.updateTime,
      statusMap.ENABLE,
      now,
      now,
    )
    .run();

  return getFeedById(db, input.id);
}

export async function updateFeed(
  db: D1Database,
  id: string,
  data: Partial<{
    mpName: string;
    mpCover: string;
    mpIntro: string;
    syncTime: number;
    updateTime: number;
    status: number;
    hasHistory: number;
  }>,
) {
  const updates: string[] = [];
  const params: unknown[] = [];

  if (data.mpName !== undefined) {
    updates.push('mp_name = ?');
    params.push(data.mpName);
  }
  if (data.mpCover !== undefined) {
    updates.push('mp_cover = ?');
    params.push(data.mpCover);
  }
  if (data.mpIntro !== undefined) {
    updates.push('mp_intro = ?');
    params.push(data.mpIntro);
  }
  if (data.syncTime !== undefined) {
    updates.push('sync_time = ?');
    params.push(data.syncTime);
  }
  if (data.updateTime !== undefined) {
    updates.push('update_time = ?');
    params.push(data.updateTime);
  }
  if (data.status !== undefined) {
    updates.push('status = ?');
    params.push(data.status);
  }
  if (data.hasHistory !== undefined) {
    updates.push('has_history = ?');
    params.push(data.hasHistory);
  }

  updates.push('updated_at = ?');
  params.push(nowMs());

  await db
    .prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run();

  return getFeedById(db, id);
}

export async function deleteFeed(db: D1Database, id: string) {
  await db.prepare('DELETE FROM feeds WHERE id = ?').bind(id).run();
}

export async function getFeedList(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, mp_name, mp_cover, mp_intro, sync_time, update_time
       FROM feeds`,
    )
    .all<FeedRow>();

  return rows.results.map((item) => ({
    id: item.id,
    name: item.mp_name,
    intro: item.mp_intro,
    cover: item.mp_cover,
    syncTime: item.sync_time,
    updateTime: item.update_time,
  }));
}

export async function listEnabledFeeds(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, mp_name, mp_cover, mp_intro, status, sync_time, update_time,
         has_history, created_at, updated_at
       FROM feeds WHERE status = ?`,
    )
    .bind(statusMap.ENABLE)
    .all<FeedRow>();

  return rows.results.map((row) => toFeedDto(row));
}

export async function listAllFeeds(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, mp_name, mp_cover, mp_intro, status, sync_time, update_time,
         has_history, created_at, updated_at
       FROM feeds`,
    )
    .all<FeedRow>();

  return rows.results.map((row) => toFeedDto(row));
}

export async function getFeedForUpdate(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT id, mp_name, mp_cover, mp_intro, status, sync_time, update_time,
         has_history, created_at, updated_at
       FROM feeds WHERE id = ?`,
    )
    .bind(id)
    .first<FeedRow>();
  return row ? toFeedDto(row) : null;
}

export async function getArticlesByMpId(
  db: D1Database,
  mpId: string,
  limit: number,
  offset: number,
) {
  const rows = await db
    .prepare(
      `SELECT id, mp_id, title, pic_url, publish_time, created_at, updated_at
       FROM articles WHERE mp_id = ?
       ORDER BY publish_time DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(mpId, limit, offset)
    .all<ArticleRow>();
  return rows.results.map((row) => toArticleDto(row));
}

export async function getAllArticles(
  db: D1Database,
  limit: number,
  offset: number,
) {
  const rows = await db
    .prepare(
      `SELECT id, mp_id, title, pic_url, publish_time, created_at, updated_at
       FROM articles
       ORDER BY publish_time DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<ArticleRow>();
  return rows.results.map((row) => toArticleDto(row));
}

export async function countArticlesByMpId(db: D1Database, mpId: string) {
  const row = await db
    .prepare('SELECT COUNT(*) as total FROM articles WHERE mp_id = ?')
    .bind(mpId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function upsertArticles(
  db: D1Database,
  mpId: string,
  articles: {
    id: string;
    title: string;
    picUrl: string;
    publishTime: number;
  }[],
) {
  const now = nowMs();
  const statements = articles.map((article) =>
    db
      .prepare(
        `INSERT INTO articles (id, mp_id, title, pic_url, publish_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           pic_url = excluded.pic_url,
           publish_time = excluded.publish_time,
           mp_id = excluded.mp_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        article.id,
        mpId,
        article.title,
        article.picUrl,
        article.publishTime,
        now,
        now,
      ),
  );

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function getAvailableAccounts(
  db: D1Database,
  blockedIds: string[],
) {
  const blockedClause = buildNotInClause(blockedIds);
  const rows = await db
    .prepare(
      `SELECT id, name, token, status, pending_login_id, created_at, updated_at
       FROM accounts
       WHERE status = ?${blockedClause.clause}
       ORDER BY created_at ASC
       LIMIT 10`,
    )
    .bind(statusMap.ENABLE, ...blockedClause.params)
    .all<AccountRow>();
  return rows.results.map((row) => toAccountDto(row));
}

export async function listEnabledAccountsWithTokens(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, token, name, status, pending_login_id, created_at, updated_at
       FROM accounts WHERE status = ?`,
    )
    .bind(statusMap.ENABLE)
    .all<AccountRow>();
  return rows.results.map((row) => toAccountDto(row));
}

export async function listInvalidAccountsWithTokens(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, token, name, status, pending_login_id, created_at, updated_at
       FROM accounts WHERE status = ?`,
    )
    .bind(statusMap.INVALID)
    .all<AccountRow>();
  return rows.results.map((row) => toAccountDto(row));
}
