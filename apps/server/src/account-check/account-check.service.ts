import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@server/prisma/prisma.service';
import { TrpcService } from '@server/trpc/trpc.service';
import { statusMap } from '@server/constants';
import { ConfigurationType } from '@server/configuration';
import Axios, { AxiosInstance } from 'axios';
import * as QRCode from 'qrcode';

@Injectable()
export class AccountCheckService {
  private readonly logger = new Logger(this.constructor.name);
  private request: AxiosInstance;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly trpcService: TrpcService,
    private readonly configService: ConfigService,
  ) {
    const { url } =
      this.configService.get<ConfigurationType['platform']>('platform')!;
    this.request = Axios.create({ baseURL: url, timeout: 15 * 1e3 });
  }

  /**
   * 检测账号是否有效
   */
  async checkAccountValidity(accountId: string, token: string): Promise<boolean> {
    try {
      const feed = await this.prismaService.feed.findFirst({
        where: { status: statusMap.ENABLE },
        orderBy: { updatedAt: 'desc' },
      });

      const testMpId = feed?.id || 'gh_test';

      await this.request.get(`/api/v2/platform/mps/${testMpId}/articles`, {
        headers: {
          xid: accountId,
          Authorization: `Bearer ${token}`,
        },
        params: { page: 1 },
      });
      return true;
    } catch (error: any) {
      const errMsg = error.response?.data?.message || '';
      const statusCode = error.response?.status;

      if (statusCode === 401 || errMsg.includes('WeReadError401')) {
        this.logger.warn(`账号 ${accountId} 检测到失效 (401)`);
        return false;
      }
      if (statusCode === 404) {
        this.logger.debug(`账号 ${accountId} 检测时公众号不存在，但 token 可能有效`);
        return true;
      }
      this.logger.debug(`账号 ${accountId} 检测时出现其他错误: ${errMsg} (status: ${statusCode})`);
      return true;
    }
  }

  /**
   * 生成二维码的 base64 图片
   */
  async generateQRCodeBase64(url: string): Promise<string> {
    try {
      return await QRCode.toDataURL(url, { width: 300, margin: 2 });
    } catch (error) {
      this.logger.error('生成二维码失败:', error);
      throw error;
    }
  }

  /**
   * 通过 webhook 发送钉钉通知
   */
  async sendWebhookNotification(
    accountId: string,
    accountName: string,
    qrCodeBase64: string,
    scanUrl: string,
  ): Promise<void> {
    const webhookUrl = process.env.ACCOUNT_CHECK_WEBHOOK_URL || '';
    if (!webhookUrl) {
      this.logger.warn('ACCOUNT_CHECK_WEBHOOK_URL is empty; skip webhook notify.');
      return;
    }

    try {
      const beijingTime = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      const markdownText = `## 微信读书账号失效通知

**账号信息：**
- 账号ID：\`${accountId}\`
- 账号名称：${accountName}
- 失效时间：${beijingTime}

**请扫描以下二维码重新登录微信账号：**

![登录二维码](${qrCodeBase64})

**二维码链接：** ${scanUrl}

**或直接访问：** [点击这里打开二维码](${scanUrl})

> 请尽快重新登录微信账号，以免影响服务使用。`;

      const payload = {
        msgtype: 'markdown',
        markdown: { title: '微信读书账号失效通知', text: markdownText },
      };

      await Axios.post(webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10 * 1e3,
      });

      this.logger.log(`已发送钉钉 webhook 通知: 账号 ${accountId} (${accountName})`);
    } catch (error: any) {
      this.logger.error(`发送 webhook 通知失败: ${error.message}`, error.stack);
      try {
        const textPayload = {
          msgtype: 'text',
          text: {
            content: `微信读书账号失效通知\n\n账号ID: ${accountId}\n账号名称: ${accountName}\n失效时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n请扫描二维码重新登录: ${scanUrl}`,
          },
        };
        await Axios.post(webhookUrl, textPayload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10 * 1e3,
        });
        this.logger.log(`已发送钉钉文本通知: 账号 ${accountId} (${accountName})`);
      } catch (textError: any) {
        this.logger.error(`发送文本通知也失败: ${textError.message}`);
      }
    }
  }

  /**
   * 尝试用已存储的 pendingLoginId 获取扫码结果（短超时，仅检查是否已有结果）。
   * 返回 true 表示 token 已更新，false 表示未完成或已过期。
   */
  private async tryResolvePendingLogin(
    account: { id: string; name: string; pendingLoginId: string },
  ): Promise<boolean> {
    try {
      const loginResult = await this.trpcService.getLoginResult(
        account.pendingLoginId,
        10 * 1e3,
      );
      if (loginResult?.vid && loginResult?.token) {
        const vid = `${loginResult.vid}`;
        if (vid === account.id) {
          await this.prismaService.account.update({
            where: { id: account.id },
            data: {
              token: loginResult.token,
              name: loginResult.username || account.name,
              status: statusMap.ENABLE,
              pendingLoginId: null,
            },
          });
          this.trpcService.removeBlockedAccount(account.id);
          this.logger.log(`账号 ${account.id} (${account.name}) 扫码成功，token 已更新`);
          return true;
        }
        // 扫码的账号与预期不符，清除旧 loginId
        this.logger.warn(`账号 ${account.id} 扫码返回不同账号(${vid})，忽略`);
        await this.prismaService.account.update({
          where: { id: account.id },
          data: { pendingLoginId: null },
        });
        return false;
      }
      return false;
    } catch {
      // pendingLoginId 对应的会话已过期或发生网络错误，清除旧 loginId
      await this.prismaService.account.update({
        where: { id: account.id },
        data: { pendingLoginId: null },
      });
      return false;
    }
  }

  /**
   * 后台短时轮询登录结果（约 5 分钟，匹配微信二维码有效期）。
   * 成功后同时清除 pendingLoginId。
   */
  private async pollLoginResult(
    account: { id: string; name: string },
    loginId: string,
  ): Promise<void> {
    const maxAttempts = 30; // 30 × (10s timeout + 5s sleep) ≈ 7.5 min
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const loginResult = await this.trpcService.getLoginResult(loginId, 10 * 1e3);
        if (loginResult?.vid && loginResult?.token) {
          const vid = `${loginResult.vid}`;
          if (vid !== account.id) {
            this.logger.warn(
              `账号 ${account.id} 扫码返回不同账号(${vid})，已忽略自动更新`,
            );
            await this.prismaService.account.update({
              where: { id: account.id },
              data: { pendingLoginId: null },
            });
            return;
          }
          await this.prismaService.account.update({
            where: { id: account.id },
            data: {
              token: loginResult.token,
              name: loginResult.username || account.name,
              status: statusMap.ENABLE,
              pendingLoginId: null,
            },
          });
          this.trpcService.removeBlockedAccount(account.id);
          this.logger.log(`账号 ${account.id} 登录信息已更新（后台轮询）`);
          return;
        }
        if (loginResult?.message) {
          this.logger.debug(`账号 ${account.id} 登录状态: ${loginResult.message}`);
        }
      } catch {
        // 忽略网络错误等，继续重试
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
    }
    this.logger.debug(`账号 ${account.id} 后台轮询超时，pendingLoginId 保留至下次 cron`);
  }

  /**
   * 处理单个失效账号：
   * 1. 若已有 pendingLoginId，先尝试获取扫码结果
   * 2. 若未完成或没有 pendingLoginId，创建新登录链接并发送通知
   * 3. 持久化保存新的 pendingLoginId 以便下次 cron 检查
   * 4. 在后台短时轮询（用户可能立即扫码）
   */
  async processInvalidAccount(
    account: { id: string; name: string; token: string; pendingLoginId: string | null },
  ): Promise<void> {
    // 先检查已有的 pendingLoginId
    if (account.pendingLoginId) {
      const resolved = await this.tryResolvePendingLogin({
        id: account.id,
        name: account.name,
        pendingLoginId: account.pendingLoginId,
      });
      if (resolved) {
        return;
      }
      // pendingLoginId 已过期（已在 tryResolvePendingLogin 中清除）
    }

    // 创建新的登录链接并发送通知
    try {
      const loginData = await this.trpcService.createLoginUrl();
      const qrCodeBase64 = await this.generateQRCodeBase64(loginData.scanUrl);

      await this.sendWebhookNotification(
        account.id,
        account.name,
        qrCodeBase64,
        loginData.scanUrl,
      );

      // 持久化 pendingLoginId，确保下次 cron 也能检查
      await this.prismaService.account.update({
        where: { id: account.id },
        data: { pendingLoginId: loginData.uuid },
      });

      // 后台短时轮询（用户可能立即扫码）
      this.pollLoginResult(account, loginData.uuid).catch((err) =>
        this.logger.error(`后台轮询账号 ${account.id} 失败`, err),
      );

      this.logger.log(`账号 ${account.id} (${account.name}) 失效处理完成，已发送通知`);
    } catch (error) {
      this.logger.error(`处理失效账号 ${account.id} 时出错:`, error);
    }
  }

  /**
   * 定时检测所有账号
   * 每次 cron：
   *   1. 主动测试所有启用账号的 token 有效性
   *   2. 处理所有失效账号（检查已有 pendingLoginId 或发送新通知）
   */
  @Cron(process.env.ACCOUNT_CHECK_CRON || '0 2,14 * * *', {
    name: 'checkAccounts',
    timeZone: 'Asia/Shanghai',
  })
  async handleAccountCheckCron() {
    this.logger.log('开始执行账号检测定时任务');

    try {
      // 第一步：主动检测所有启用账号
      const enabledAccounts = await this.prismaService.account.findMany({
        where: { status: statusMap.ENABLE },
        select: { id: true, name: true, token: true },
      });

      this.logger.log(`找到 ${enabledAccounts.length} 个启用状态的账号，开始检测`);

      for (const account of enabledAccounts) {
        const isValid = await this.checkAccountValidity(account.id, account.token);
        if (!isValid) {
          this.logger.warn(`账号 ${account.id} (${account.name}) 检测失效，标记为失效`);
          await this.prismaService.account.update({
            where: { id: account.id },
            data: { status: statusMap.INVALID },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
      }

      // 第二步：处理所有失效账号（包括刚刚检测失效的 + 已有的失效账号）
      const invalidAccounts = await this.prismaService.account.findMany({
        where: { status: statusMap.INVALID },
        select: { id: true, name: true, token: true, pendingLoginId: true },
      });

      this.logger.log(`找到 ${invalidAccounts.length} 个失效账号，开始处理`);

      for (const account of invalidAccounts) {
        await this.processInvalidAccount(account);
        await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
      }

      this.logger.log('账号检测定时任务执行完成');
    } catch (error) {
      this.logger.error('账号检测定时任务执行出错:', error);
    }
  }

  /**
   * 手动触发账号检测
   */
  async manualCheck(accountId?: string) {
    this.logger.log(`手动触发账号检测${accountId ? `: ${accountId}` : ' (所有账号)'}`);

    try {
      const where = accountId
        ? { id: accountId, status: statusMap.ENABLE }
        : { status: statusMap.ENABLE };

      const accounts = await this.prismaService.account.findMany({
        where,
        select: { id: true, name: true, token: true },
      });

      if (accounts.length === 0) {
        this.logger.warn('未找到需要检测的账号');
        return;
      }

      for (const account of accounts) {
        const isValid = await this.checkAccountValidity(account.id, account.token);
        if (!isValid) {
          await this.prismaService.account.update({
            where: { id: account.id },
            data: { status: statusMap.INVALID },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
      }

      const invalidAccounts = await this.prismaService.account.findMany({
        where: accountId
          ? { id: accountId, status: statusMap.INVALID }
          : { status: statusMap.INVALID },
        select: { id: true, name: true, token: true, pendingLoginId: true },
      });

      for (const account of invalidAccounts) {
        await this.processInvalidAccount(account);
        await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
      }

      this.logger.log('手动账号检测完成');
    } catch (error) {
      this.logger.error('手动账号检测出错:', error);
      throw error;
    }
  }

  /**
   * 测试 webhook 推送功能
   */
  async testWebhookNotification(): Promise<void> {
    this.logger.log('开始测试 webhook 推送功能');

    try {
      const loginData = await this.trpcService.createLoginUrl();
      const qrCodeBase64 = await this.generateQRCodeBase64(loginData.scanUrl);

      await this.sendWebhookNotification(
        'TEST_ACCOUNT_ID',
        '测试微信账号',
        qrCodeBase64,
        loginData.scanUrl,
      );

      this.logger.log('测试 webhook 推送完成');
    } catch (error) {
      this.logger.error('测试 webhook 推送失败:', error);
      throw error;
    }
  }
}
