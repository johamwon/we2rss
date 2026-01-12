import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { Env } from './types';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';
import {
  getFeedListResponse,
  handleGenerateFeed,
  handleUpdateFeedsCron,
  updateFeedOnce,
} from './services/feeds';
import {
  handleAccountCheckCron,
  testWebhookNotification,
} from './services/account-check';
import { getLoginResult } from './services/trpc-service';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.onError((err) => {
  console.error('[worker] unhandled error:', err);
  return new Response('Internal Server Error', { status: 500 });
});

app.get('/', (c) => c.text('WeWe RSS worker is running'));

app.get('/robots.txt', (c) => c.text('User-agent:  *\nDisallow:  /'));

app.get('/feeds', async (c) => {
  const data = await getFeedListResponse(c.env);
  return c.json(data);
});

function getFeedErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Failed to generate feed';
  if (message.includes('不存在该feed')) {
    return new Response('Feed not found', { status: 404 });
  }
  console.error('[feeds] error generating feed:', error);
  return new Response('Internal Server Error', { status: 500 });
}

app.get('/feeds/all.:type', async (c) => {
  try {
    const type = c.req.param('type');
    const limit = Number(c.req.query('limit') ?? '30');
    const page = Number(c.req.query('page') ?? '1');
    const mode = c.req.query('mode');
    const titleInclude = c.req.query('title_include');
    const titleExclude = c.req.query('title_exclude');

    const { content, mimeType } = await handleGenerateFeed(c.env, {
      type,
      limit,
      page,
      mode: mode || undefined,
      title_include: titleInclude || undefined,
      title_exclude: titleExclude || undefined,
    });

    return new Response(content, {
      headers: { 'Content-Type': mimeType },
    });
  } catch (error) {
    return getFeedErrorResponse(error);
  }
});

app.get('/feeds/:feed', async (c) => {
  try {
    const feed = c.req.param('feed');
    const [id, type] = feed.split('.');
    const limit = Number(c.req.query('limit') ?? '10');
    const page = Number(c.req.query('page') ?? '1');
    const mode = c.req.query('mode');
    const titleInclude = c.req.query('title_include');
    const titleExclude = c.req.query('title_exclude');
    const update = c.req.query('update') === 'true';

    if (!id) {
      return new Response('Feed not found', { status: 404 });
    }

    if (id === 'all') {
      const { content, mimeType } = await handleGenerateFeed(c.env, {
        type,
        limit,
        page,
        mode: mode || undefined,
        title_include: titleInclude || undefined,
        title_exclude: titleExclude || undefined,
      });

      return new Response(content, {
        headers: { 'Content-Type': mimeType },
      });
    }

    if (update) {
      c.executionCtx.waitUntil(updateFeedOnce(c.env, id));
    }

    const { content, mimeType } = await handleGenerateFeed(c.env, {
      id,
      type,
      limit,
      page,
      mode: mode || undefined,
      title_include: titleInclude || undefined,
      title_exclude: titleExclude || undefined,
    });

    return new Response(content, {
      headers: { 'Content-Type': mimeType },
    });
  } catch (error) {
    return getFeedErrorResponse(error);
  }
});

app.get('/test-webhook', async (c) => {
  const debug = c.req.query('debug') === 'true';
  try {
    await testWebhookNotification(c.env);
    return c.json({ success: true, message: '测试webhook通知已发送' });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Test webhook failed';
    return c.json(
      { success: false, message: debug ? message : 'Test webhook failed' },
      500,
    );
  }
});

app.post('/admin/account-check', async (c) => {
  const authCode = c.env.AUTH_CODE?.trim();
  const requestAuth =
    c.req.header('authorization') ?? c.req.query('auth') ?? '';
  if (authCode && requestAuth !== authCode) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }

  c.executionCtx.waitUntil(handleAccountCheckCron(c.env));
  return c.json({ success: true, queued: true });
});

app.get('/admin/login-result', async (c) => {
  const authCode = c.env.AUTH_CODE?.trim();
  const requestAuth =
    c.req.header('authorization') ?? c.req.query('auth') ?? '';
  if (authCode && requestAuth !== authCode) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }

  const uuid = c.req.query('uuid')?.trim();
  if (!uuid) {
    return c.json({ success: false, message: 'Missing uuid' }, 400);
  }

  try {
    const result = await getLoginResult(c.env, uuid);
    return c.json({ success: true, result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Login query failed';
    return c.json({ success: false, message }, 500);
  }
});

const trpcHandler = (req: Request, env: Env) =>
  fetchRequestHandler({
    endpoint: '/trpc',
    req,
    router: appRouter,
    createContext: () => createContext(env, req),
  });

app.all('/trpc', (c) => trpcHandler(c.req.raw, c.env));
app.all('/trpc/*', (c) => trpcHandler(c.req.raw, c.env));

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    const feedCron = env.FEED_CRON ?? '35 5,17 * * *';
    const accountCron = env.ACCOUNT_CHECK_CRON ?? '0 2,14 * * *';

    if (event.cron === accountCron) {
      ctx.waitUntil(handleAccountCheckCron(env));
      return;
    }

    if (event.cron === feedCron) {
      ctx.waitUntil(handleUpdateFeedsCron(env));
      return;
    }

    // Fallback: run both when cron mismatches env vars (e.g., dashboard override).
    ctx.waitUntil(handleAccountCheckCron(env));
    ctx.waitUntil(handleUpdateFeedsCron(env));
  },
};
