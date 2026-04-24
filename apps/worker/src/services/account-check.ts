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

/**
 * 尝试用已存储的 pendingLoginId 获取扫码结果。
 * 使用较短的超时避免阻塞，只检查平台是否已有结果。
 * 返回 true 表示已成功更新 token，false 表示未完成或已过期。
 */
async function tryResolvePendingLogin(
  env: Env,
  account: { id: string; name: string; pendingLoginId: string },
): Promise<boolean> {
  try {
    const loginResult = await getLoginResult(env, account.pendingLoginId, 10000);
    if (loginResult?.vid && loginResult?.token) {
      const vid = `${loginResult.vid}`;
      if (vid === account.id) {
        await updateAccount(env.DB, account.id, {
          token: loginResult.token,
          name: loginResult.username || account.name,
          status: statusMap.ENABLE,
          pendingLoginId: null,
        });
        removeBlockedAccount(account.id);
        console.log(`[account-check] 账号 ${account.id} (${account.name}) 扫码成功，token 已更新`);
        return true;
      }
      // 扫码的账号与预期不符，清除旧 loginId
      console.warn(`[account-check] 账号 ${account.id} 扫码返回不同账号(${vid})，忽略`);
      await updateAccount(env.DB, account.id, { pendingLoginId: null });
      return false;
    }
    // 尚未扫码或返回了无效数据
    return false;
  } catch {
    // pendingLoginId 对应的会话已过期或发生网络错误，清除旧 loginId
    await updateAccount(env.DB, account.id, { pendingLoginId: null });
    return false;
  }
}

/**
 * 在短时间内轮询登录结果（供刚发送二维码后立即等待使用）。
 * 最多轮询 maxAttempts 次，每次间隔 intervalMs。
 */
async function pollLoginResult(
  env: Env,
  account: { id: string; name: string },
  loginId: string,
  maxAttempts = 30,
  intervalMs = 10000,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const loginResult = await getLoginResult(env, loginId, intervalMs);
      if (loginResult?.vid && loginResult?.token) {
        const vid = `${loginResult.vid}`;
        if (vid === account.id) {
          await updateAccount(env.DB, account.id, {
            token: loginResult.token,
            name: loginResult.username || account.name,
            status: statusMap.ENABLE,
            pendingLoginId: null,
          });
          removeBlockedAccount(account.id);
          console.log(`[account-check] 账号 ${account.id} (${account.name}) 实时轮询成功，token 已更新`);
          return;
        }
        // 扫码的账号与预期不符，停止轮询
        await updateAccount(env.DB, account.id, { pendingLoginId: null });
        return;
      }
    } catch {
      // 未扫码时平台通常返回 4xx，继续重试
    }
    await sleep(5 * 1000);
  }
}

/**
 * 处理单个失效账号：
 * 1. 若已有 pendingLoginId，先尝试获取扫码结果
 * 2. 若未完成或没有 pendingLoginId，创建新的登录链接并发送通知
 * 3. 保存新的 pendingLoginId 以便下次 cron 检查
 * 返回新的 loginId（若需要轮询），否则返回 null
 */
async function processInvalidAccount(
  env: Env,
  account: { id: string; name: string; token: string; pendingLoginId: string | null },
): Promise<{ loginId: string; account: { id: string; name: string } } | null> {
  // 先尝试解析已有的 pendingLoginId
  if (account.pendingLoginId) {
    const resolved = await tryResolvePendingLogin(env, {
      id: account.id,
      name: account.name,
      pendingLoginId: account.pendingLoginId,
    });
    if (resolved) {
      return null; // token 已更新，无需继续
    }
    // pendingLoginId 已过期，将在上面的 tryResolvePendingLogin 中被清除
  }

  // 创建新的登录链接并发送钉钉通知
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

  // 持久化保存 pendingLoginId，确保下次 cron 也能检查
  await updateAccount(env.DB, account.id, { pendingLoginId: loginData.uuid });

  return { loginId: loginData.uuid, account: { id: account.id, name: account.name } };
}

export async function checkAndHandleAccount(env: Env, account: {
  id: string;
  name: string;
  token: string;
  pendingLoginId: string | null;
}) {
  const isValid = await checkAccountValidity(env, account.id, account.token);
  if (isValid) {
    // 账号已恢复有效，清除可能残留的 pendingLoginId
    if (account.pendingLoginId) {
      await updateAccount(env.DB, account.id, { pendingLoginId: null });
    }
    await updateAccount(env.DB, account.id, { status: statusMap.ENABLE });
    return;
  }

  await updateAccount(env.DB, account.id, { status: statusMap.INVALID });
  await processInvalidAccount(env, account);
}

export async function handleAccountCheckCron(env: Env) {
  const invalidAccounts = await listInvalidAccountsWithTokens(env.DB);
  if (invalidAccounts.length === 0) {
    return;
  }

  // 第一阶段：为每个失效账号处理通知和 pendingLoginId（快速串行，避免并发写冲突）
  const pollTargets: Array<{ loginId: string; account: { id: string; name: string } }> = [];
  for (const account of invalidAccounts) {
    try {
      const result = await processInvalidAccount(env, account);
      if (result) {
        pollTargets.push(result);
      }
    } catch (error) {
      console.error(`[account-check] 处理账号 ${account.id} 时出错:`, error);
    }
    await sleep(5 * 1000);
  }

  // 第二阶段：并发轮询所有新建登录链接（不相互阻塞）
  if (pollTargets.length > 0) {
    await Promise.allSettled(
      pollTargets.map(({ account, loginId }) =>
        pollLoginResult(env, account, loginId),
      ),
    );
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

