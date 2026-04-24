export type DbRow = Record<string, unknown>;

export interface AccountRow extends DbRow {
  id: string;
  token: string;
  name: string;
  status: number;
  pending_login_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FeedRow extends DbRow {
  id: string;
  mp_name: string;
  mp_cover: string;
  mp_intro: string;
  status: number;
  sync_time: number;
  update_time: number;
  has_history: number;
  created_at: number;
  updated_at: number;
}

export interface ArticleRow extends DbRow {
  id: string;
  mp_id: string;
  title: string;
  pic_url: string;
  publish_time: number;
  created_at: number;
  updated_at: number;
}

export const nowMs = () => Date.now();

export function toIso(ms: number) {
  return new Date(ms).toISOString();
}

export function toAccountDto(row: AccountRow) {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    status: row.status,
    pendingLoginId: row.pending_login_id ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toAccountPublicDto(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toFeedDto(row: FeedRow) {
  return {
    id: row.id,
    mpName: row.mp_name,
    mpCover: row.mp_cover,
    mpIntro: row.mp_intro,
    status: row.status,
    syncTime: row.sync_time,
    updateTime: row.update_time,
    hasHistory: row.has_history,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toArticleDto(row: ArticleRow) {
  return {
    id: row.id,
    mpId: row.mp_id,
    title: row.title,
    picUrl: row.pic_url,
    publishTime: row.publish_time,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
