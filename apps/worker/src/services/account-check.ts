import type { Env } from '../types';
import { statusMap } from '../constants';
import {
  listInvalidAccountsWithTokens,
  listEnabledFeeds,
  updateAccount,
} from './db-queries';
import { createLoginUrl, getLoginResult, removeBlockedAccount } from './trpc-service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getWebhookUrl(env: Env) {
  return env.ACCOUNT_CHECK_WEBHOOK_URL ?? '';
}

async function fetchJson<T>(
  env: Env,
  path: string,
  options: RequestInit = {},
) {
  const res = await fetch(
    `${env.PLATFORM_URL ?? 'https://weread.111965.xyz'}${path}`,
    options,
  );
  const data = (await res.json().catch(() => ({}))) as T & {
    message?: string;
  };
  if (!res.ok) {
    const error = new Error(data?.message || `Request failed: ${res.status}`);
    (error as any).status = res.status;
    (error as any).data = data;
    throw error;
  }
  return data;
}

export async function checkAccountValidity(
  env: Env,
  accountId: string,
  token: string,
) {
  try {
    const feeds = await listEnabledFeeds(env.DB);
    const testMpId = feeds[0]?.id || 'gh_test';

    await fetchJson(env, `/api/v2/platform/mps/${testMpId}/articles?page=1`, {
      headers: {
        xid: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    return true;
  } catch (error: any) {
    const errMsg = error?.data?.message || '';
    const statusCode = error?.status;
    if (statusCode === 401 || errMsg.includes('WeReadError401')) {
      return false;
    }
    if (statusCode === 404) {
      return true;
    }
    return true;
  }
}

export function getQrCodeImageUrl(url: string) {
  const encoded = encodeURIComponent(url);
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encoded}`;
}

export async function sendWebhookNotification(
  env: Env,
  accountId: string,
  accountName: string,
  qrCodeUrl: string,
  scanUrl: string,
  loginId: string,
) {
  const webhookUrl = getWebhookUrl(env);
  if (!webhookUrl) {
    console.warn('[account-check] ACCOUNT_CHECK_WEBHOOK_URL is empty');
    return;
  }
  const beijingTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const qrSection = qrCodeUrl
    ? `![登录二维码](${qrCodeUrl})\n\n`
    : '';

  const markdownText = `## 微信读书账号失效通知

**账号信息：**
- 账号ID：\`${accountId}\`
- 账号名称：${accountName}
- 失效时间：${beijingTime}

**请扫描以下二维码重新登录微信账号：**

${qrSection}

**二维码链接：** ${scanUrl}

**登录ID：** \`${loginId}\`

**或直接访问：** [点击这里打开二维码](${scanUrl})

> 请尽快重新登录微信账号，以免影响服务使用。`;

  const payload = {
    msgtype: 'markdown',
    markdown: {
      title: '微信读书账号失效通知',
      text: markdownText,
    },
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function checkAndHandleAccount(env: Env, account: {
  id: string;
  name: string;
  token: string;
}) {
  const isValid = await checkAccountValidity(env, account.id, account.token);
  if (isValid) {
    await updateAccount(env.DB, account.id, { status: statusMap.ENABLE });
    return;
  }

  await updateAccount(env.DB, account.id, { status: statusMap.INVALID });

  const loginData = await createLoginUrl(env);
  const qrCodeUrl = getQrCodeImageUrl(loginData.scanUrl);
  await sendWebhookNotification(
    env,
    account.id,
    account.name,
    qrCodeUrl,
    loginData.scanUrl,
    loginData.uuid,
  );

  await tryRefreshAccountFromLogin(env, account, loginData.uuid);
}

async function tryRefreshAccountFromLogin(
  env: Env,
  account: { id: string; name: string },
  loginId: string,
) {
  try {
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const loginResult = await getLoginResult(env, loginId, 10000);
        if (loginResult?.vid && loginResult?.token) {
          const vid = `${loginResult.vid}`;
          if (vid === account.id) {
            await updateAccount(env.DB, account.id, {
              token: loginResult.token,
              name: loginResult.username || account.name,
              status: statusMap.ENABLE,
            });
            removeBlockedAccount(account.id);
          }
          return;
        }
      } catch (error) {
        // Login result often returns 4xx until the user confirms.
      }
      await sleep(5 * 1000);
    }
  } catch (error) {
    console.error('[account-check] failed to refresh account from login:', error);
  }
}

export async function handleAccountCheckCron(env: Env) {
  const invalidAccounts = await listInvalidAccountsWithTokens(env.DB);
  for (const account of invalidAccounts) {
    await checkAndHandleAccount(env, account);
    await sleep(5 * 1000);
  }
}

export async function testWebhookNotification(env: Env) {
  const loginData = await createLoginUrl(env);
  const qrCodeUrl = getQrCodeImageUrl(loginData.scanUrl);
  await sendWebhookNotification(
    env,
    'TEST_ACCOUNT_ID',
    '测试微信账号',
    qrCodeUrl,
    loginData.scanUrl,
    loginData.uuid,
  );
}
