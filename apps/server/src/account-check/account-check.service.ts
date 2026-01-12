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
   * 通过调用API来验证token是否有效
   * 使用数据库中已有的feed来测试，如果没有feed则使用一个通用的检测方法
   */
  async checkAccountValidity(accountId: string, token: string): Promise<boolean> {
    try {
      // 尝试获取一个feed来测试token
      // 优先使用数据库中已有的feed
      const feed = await this.prismaService.feed.findFirst({
        where: { status: statusMap.ENABLE },
        orderBy: { updatedAt: 'desc' },
      });

      const testMpId = feed?.id || 'gh_test'; // 使用已有的feed或测试ID
      
      await this.request.get(`/api/v2/platform/mps/${testMpId}/articles`, {
        headers: {
          xid: accountId,
          Authorization: `Bearer ${token}`,
        },
        params: {
          page: 1,
        },
      });
      return true;
    } catch (error: any) {
      const errMsg = error.response?.data?.message || '';
      const statusCode = error.response?.status;
      
      // 401错误表示token失效
      if (statusCode === 401 || errMsg.includes('WeReadError401')) {
        this.logger.warn(`账号 ${accountId} 检测到失效 (401)`);
        return false;
      }
      
      // 404或其他错误可能是公众号不存在，但不代表token失效
      // 只有401才判定为失效
      if (statusCode === 404) {
        this.logger.debug(`账号 ${accountId} 检测时公众号不存在，但token可能有效`);
        return true; // 404表示公众号不存在，但token可能是有效的
      }
      
      // 其他错误可能是网络问题等，不判定为失效
      this.logger.debug(`账号 ${accountId} 检测时出现其他错误: ${errMsg} (status: ${statusCode})`);
      return true; // 暂时认为有效，避免误判
    }
  }

  /**
   * 生成二维码的base64图片
   */
  async generateQRCodeBase64(url: string): Promise<string> {
    try {
      const qrCodeDataUrl = await QRCode.toDataURL(url, {
        width: 300,
        margin: 2,
      });
      return qrCodeDataUrl;
    } catch (error) {
      this.logger.error('生成二维码失败:', error);
      throw error;
    }
  }

  /**
   * 通过webhook发送通知（钉钉机器人）
   */
  async sendWebhookNotification(
    accountId: string,
    accountName: string,
    qrCodeBase64: string,
    scanUrl: string,
  ): Promise<void> {
    // 钉钉机器人webhook URL
    const webhookUrl =
      process.env.ACCOUNT_CHECK_WEBHOOK_URL ||
      'https://oapi.dingtalk.com/robot/send?access_token=f9612510b343e6d8bffc60b2a0d7168593b1bb93e55a75a1a1e0dd2c80555c40';

    try {
      // 格式化时间为北京时间
      const beijingTime = new Date().toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      // 构建钉钉markdown消息（包含"微信"两个字）
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
        markdown: {
          title: '微信读书账号失效通知',
          text: markdownText,
        },
      };

      await Axios.post(webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10 * 1e3,
      });

      this.logger.log(`已发送钉钉webhook通知: 账号 ${accountId} (${accountName})`);
    } catch (error: any) {
      this.logger.error(`发送webhook通知失败: ${error.message}`, error.stack);
      // 如果markdown格式失败，尝试发送文本消息
      try {
        const textPayload = {
          msgtype: 'text',
          text: {
            content: `微信读书账号失效通知\n\n账号ID: ${accountId}\n账号名称: ${accountName}\n失效时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n请扫描二维码重新登录: ${scanUrl}`,
          },
        };
        await Axios.post(webhookUrl, textPayload, {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10 * 1e3,
        });
        this.logger.log(`已发送钉钉文本通知: 账号 ${accountId} (${accountName})`);
      } catch (textError: any) {
        this.logger.error(`发送文本通知也失败: ${textError.message}`);
      }
    }
  }

  /**
   * 检测单个账号并处理失效情况
   */
  async checkAndHandleAccount(account: { id: string; name: string; token: string }) {
    this.logger.debug(`开始检测账号: ${account.id} (${account.name})`);

    const isValid = await this.checkAccountValidity(account.id, account.token);

    if (!isValid) {
      this.logger.warn(`账号 ${account.id} (${account.name}) 已失效，开始处理`);

      // 更新账号状态为失效
      await this.prismaService.account.update({
        where: { id: account.id },
        data: { status: statusMap.INVALID },
      });

      // 生成新的登录二维码
      try {
        const loginData = await this.trpcService.createLoginUrl();
        const qrCodeBase64 = await this.generateQRCodeBase64(loginData.scanUrl);

        // 发送webhook通知
        await this.sendWebhookNotification(
          account.id,
          account.name,
          qrCodeBase64,
          loginData.scanUrl,
        );

        // 不await，让它在后台轮询检测登录状态
        this.tryRefreshAccountFromLogin(account, loginData.uuid).catch((err) =>
          this.logger.error(`后台轮询账号 ${account.id} 失败`, err),
        );

        this.logger.log(
          `账号 ${account.id} (${account.name}) 失效处理完成，已发送通知`,
        );
      } catch (error) {
        this.logger.error(
          `处理失效账号 ${account.id} 时出错:`,
          error,
        );
      }
    } else {
      this.logger.debug(`账号 ${account.id} (${account.name}) 状态正常`);
    }
  }

  private async tryRefreshAccountFromLogin(
    account: { id: string; name: string },
    loginId: string,
  ) {
    const startTime = Date.now();
    const timeout = 10 * 60 * 1000; // 10分钟超时

    this.logger.log(`开始轮询账号 ${account.id} 的登录结果...`);

    while (Date.now() - startTime < timeout) {
      try {
        const loginResult = await this.trpcService.getLoginResult(loginId);
        if (loginResult?.vid && loginResult?.token) {
          const vid = `${loginResult.vid}`;
          if (vid !== account.id) {
            this.logger.warn(
              `账号 ${account.id} 扫码返回不同账号(${vid})，已忽略自动更新`,
            );
            return;
          }

          await this.prismaService.account.update({
            where: { id: account.id },
            data: {
              token: loginResult.token,
              name: loginResult.username || account.name,
              status: statusMap.ENABLE,
            },
          });
          this.trpcService.removeBlockedAccount(account.id);
          this.logger.log(`账号 ${account.id} 登录信息已更新`);
          return;
        }

        // 如果有message但没有token，可能是还在等待扫码或确认
        if (loginResult?.message) {
          this.logger.debug(
            `账号 ${account.id} 登录状态: ${loginResult.message}`,
          );
        }
      } catch (error) {
        // 忽略网络错误等，继续重试
        this.logger.debug(`轮询登录结果临时错误: ${error}`);
      }

      // 等待3秒再次检查
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    this.logger.warn(`账号 ${account.id} 登录轮询超时`);
  }

  /**
   * 定时检测所有启用的账号
   * 每4小时执行一次
   */
  @Cron(process.env.ACCOUNT_CHECK_CRON || '0 2,14 * * *', {
    name: 'checkAccounts',
    timeZone: 'Asia/Shanghai',
  })
  async handleAccountCheckCron() {
    this.logger.log('开始执行账号检测定时任务');

    try {
      // 获取所有启用状态的账号
      const accounts = await this.prismaService.account.findMany({
        where: {
          status: statusMap.ENABLE,
        },
        select: {
          id: true,
          name: true,
          token: true,
        },
      });

      this.logger.log(`找到 ${accounts.length} 个启用状态的账号，开始检测`);

      // 逐个检测账号
      for (const account of accounts) {
        await this.checkAndHandleAccount(account);
        // 每个账号检测间隔5秒，避免请求过于频繁
        await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
      }

      this.logger.log('账号检测定时任务执行完成');
    } catch (error) {
      this.logger.error('账号检测定时任务执行出错:', error);
    }
  }

  /**
   * 手动触发账号检测（可用于测试）
   */
  async manualCheck(accountId?: string) {
    this.logger.log(`手动触发账号检测${accountId ? `: ${accountId}` : ' (所有账号)'}`);

    try {
      const where = accountId
        ? { id: accountId, status: statusMap.ENABLE }
        : { status: statusMap.ENABLE };

      const accounts = await this.prismaService.account.findMany({
        where,
        select: {
          id: true,
          name: true,
          token: true,
        },
      });

      if (accounts.length === 0) {
        this.logger.warn('未找到需要检测的账号');
        return;
      }

      for (const account of accounts) {
        await this.checkAndHandleAccount(account);
        await new Promise((resolve) => setTimeout(resolve, 5 * 1e3));
      }

      this.logger.log('手动账号检测完成');
    } catch (error) {
      this.logger.error('手动账号检测出错:', error);
      throw error;
    }
  }

  /**
   * 测试webhook推送功能
   */
  async testWebhookNotification(): Promise<void> {
    this.logger.log('开始测试webhook推送功能');

    try {
      // 生成测试用的登录二维码
      const loginData = await this.trpcService.createLoginUrl();
      const qrCodeBase64 = await this.generateQRCodeBase64(loginData.scanUrl);

      // 发送测试通知
      await this.sendWebhookNotification(
        'TEST_ACCOUNT_ID',
        '测试微信账号',
        qrCodeBase64,
        loginData.scanUrl,
      );

      this.logger.log('测试webhook推送完成');
    } catch (error) {
      this.logger.error('测试webhook推送失败:', error);
      throw error;
    }
  }
}

