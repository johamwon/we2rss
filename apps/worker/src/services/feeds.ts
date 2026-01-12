import { Feed, Item } from 'feed';
import { load } from 'cheerio';
import { LRUCache } from 'lru-cache';
import type { Env } from '../types';
import { feedMimeTypeMap, feedTypes, statusMap } from '../constants';
import {
  getAllArticles,
  getArticlesByMpId,
  getFeedById,
  getFeedList,
  listAllFeeds,
  listEnabledFeeds,
} from './db-queries';
import { refreshMpArticlesAndUpdateFeed } from './trpc-service';

const mpCache = new LRUCache<string, string>({ max: 5000 });

const defaultHeaders = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'max-age=0',
  'sec-ch-ua':
    '" Not A;Brand";v="99", "Chromium";v="101", "Google Chrome";v="101"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldCleanHtml = (env: Env) =>
  (env.ENABLE_CLEAN_HTML ?? 'false').toLowerCase() === 'true';

const getFeedMode = (env: Env) => env.FEED_MODE ?? '';

const getOriginUrl = (env: Env, fallback: string) =>
  env.SERVER_ORIGIN_URL ?? fallback;

const getUpdateDelaySeconds = (env: Env) => {
  const raw = env.UPDATE_DELAY_TIME ?? '60';
  const value = Number(raw);
  return Number.isFinite(value) ? value : 60;
};

async function cleanHtml(source: string) {
  const $ = load(source, { decodeEntities: false });
  const dirtyHtml = $.html($('.rich_media_content'));
  const html = dirtyHtml
    .replace(/data-src=/g, 'src=')
    .replace(/opacity: 0( !important)?;/g, '')
    .replace(/visibility: hidden;/g, '');

  const content =
    '<style> .rich_media_content {overflow: hidden;color: #222;font-size: 17px;word-wrap: break-word;-webkit-hyphens: auto;-ms-hyphens: auto;hyphens: auto;text-align: justify;position: relative;z-index: 0;}.rich_media_content {font-size: 18px;}</style>' +
    html;

  return content;
}

async function getHtmlByUrl(env: Env, url: string) {
  const res = await fetch(url, { headers: defaultHeaders });
  const html = await res.text();
  if (shouldCleanHtml(env)) {
    return cleanHtml(html);
  }
  return html;
}

async function tryGetContent(env: Env, id: string) {
  const cached = mpCache.get(id);
  if (cached) {
    return cached;
  }
  const url = `https://mp.weixin.qq.com/s/${id}`;
  const content = await getHtmlByUrl(env, url).catch(() => {
    return '获取全文失败，请重试~';
  });
  mpCache.set(id, content);
  return content;
}

async function renderFeed(env: Env, opts: { type: string; feedInfo: any; articles: any[]; mode?: string }) {
  const originUrl = getOriginUrl(env, '');
  const link = `${originUrl}/feeds/${opts.feedInfo.id}.${opts.type}`;
  const feed = new Feed({
    title: opts.feedInfo.mpName,
    description: opts.feedInfo.mpIntro,
    id: link,
    link,
    language: 'zh-cn',
    image: opts.feedInfo.mpCover,
    favicon: opts.feedInfo.mpCover,
    copyright: '',
    updated: new Date(opts.feedInfo.updateTime * 1e3),
    generator: 'we2rss',
    author: { name: opts.feedInfo.mpName },
  });

  feed.addExtension({ name: 'generator', objects: `we2rss` });

  const feeds = await listAllFeeds(env.DB);
  const enableFullText =
    typeof opts.mode === 'string'
      ? opts.mode === 'fulltext'
      : getFeedMode(env) === 'fulltext';
  const showAuthor = opts.feedInfo.id === 'all';

  const mapper = async (item: any) => {
    const { title, id, publishTime, picUrl, mpId } = item;
    const link = `https://mp.weixin.qq.com/s/${id}`;
    const mpName = feeds.find((feed) => feed.id === mpId)?.mpName || '-';
    const published = new Date(publishTime * 1e3);

    let content = '';
    if (enableFullText) {
      content = await tryGetContent(env, id);
    }

    feed.addItem({
      id,
      title,
      link,
      guid: link,
      content,
      date: published,
      image: picUrl,
      author: showAuthor ? [{ name: mpName }] : undefined,
    });
  };

  for (const item of opts.articles) {
    await mapper(item);
  }
  return feed;
}

export async function handleGenerateFeed(env: Env, opts: {
  id?: string;
  type: string;
  limit: number;
  page: number;
  mode?: string;
  title_include?: string;
  title_exclude?: string;
}) {
  let type = opts.type;
  if (!feedTypes.includes(type as any)) {
    type = 'atom';
  }

  let articles: any[] = [];
  let feedInfo: any;

  if (opts.id) {
    feedInfo = await getFeedById(env.DB, opts.id);
    if (!feedInfo) {
      throw new Error('不存在该feed');
    }
    articles = await getArticlesByMpId(
      env.DB,
      opts.id,
      opts.limit,
      (opts.page - 1) * opts.limit,
    );
  } else {
    articles = await getAllArticles(
      env.DB,
      opts.limit,
      (opts.page - 1) * opts.limit,
    );
    const originUrl = env.SERVER_ORIGIN_URL ?? '';
    feedInfo = {
      id: 'all',
      mpName: 'we2rss All',
      mpIntro: 'we2rss 全部文章',
      mpCover: originUrl
        ? `${originUrl}/favicon.ico`
        : 'https://r2-assets.111965.xyz/wewe-rss.png',
      status: statusMap.ENABLE,
      syncTime: 0,
      updateTime: Math.floor(Date.now() / 1e3),
      hasHistory: -1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const feed = await renderFeed(env, {
    type,
    feedInfo,
    articles,
    mode: opts.mode,
  });

  if (opts.title_include) {
    const includes = opts.title_include.split('|');
    feed.items = feed.items.filter((i: Item) =>
      includes.some((k) => i.title?.includes(k)),
    );
  }
  if (opts.title_exclude) {
    const excludes = opts.title_exclude.split('|');
    feed.items = feed.items.filter(
      (i: Item) => !excludes.some((k) => i.title?.includes(k)),
    );
  }

  switch (type) {
    case 'rss':
      return { content: feed.rss2(), mimeType: feedMimeTypeMap[type] };
    case 'json':
      return { content: feed.json1(), mimeType: feedMimeTypeMap[type] };
    case 'atom':
    default:
      return { content: feed.atom1(), mimeType: feedMimeTypeMap[type] };
  }
}

export async function handleUpdateFeedsCron(env: Env) {
  const feeds = await listEnabledFeeds(env.DB);
  const delaySeconds = getUpdateDelaySeconds(env);

  for (const feed of feeds) {
    try {
      await refreshMpArticlesAndUpdateFeed(env, feed.id);
      await sleep(delaySeconds * 1000);
    } finally {
      await sleep(30 * 1000);
    }
  }
}

export async function getFeedListResponse(env: Env) {
  return getFeedList(env.DB);
}

export async function updateFeedOnce(env: Env, id: string) {
  try {
    await refreshMpArticlesAndUpdateFeed(env, id);
  } finally {
    await sleep(30 * 1000);
  }
}
