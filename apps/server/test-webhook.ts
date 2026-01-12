/**
 * 测试webhook推送功能的脚本
 * 使用方法: npx ts-node test-webhook.ts
 */

import Axios from 'axios';
import * as QRCode from 'qrcode';

async function testWebhook() {
  // 钉钉机器人webhook URL
  const webhookUrl = process.env.ACCOUNT_CHECK_WEBHOOK_URL || '';
  if (!webhookUrl) {
    throw new Error('ACCOUNT_CHECK_WEBHOOK_URL is required');
  }

  // 获取真实的登录二维码URL
  const platformUrl = process.env.PLATFORM_URL || 'https://weread.111965.xyz';
  let testScanUrl: string;
  
  try {
    console.log('正在获取真实的登录二维码URL...');
    const loginResponse = await Axios.get(`${platformUrl}/api/v2/login/platform`, {
      timeout: 15 * 1e3,
    });
    testScanUrl = loginResponse.data.scanUrl;
    console.log('✅ 获取登录URL成功:', testScanUrl);
  } catch (error: any) {
    console.warn('⚠️ 获取真实登录URL失败，使用测试URL:', error.message);
    testScanUrl = 'https://example.com/login';
  }

  const qrCodeBase64 = await QRCode.toDataURL(testScanUrl, {
    width: 300,
    margin: 2,
  });

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

  // 构建钉钉markdown消息（包含"微信"两个字和登录二维码）
  const markdownText = `## 微信读书账号失效通知（测试）

**账号信息：**
- 账号ID：\`TEST_ACCOUNT_ID\`
- 账号名称：测试微信账号
- 失效时间：${beijingTime}

**请扫描以下二维码重新登录微信账号：**

![登录二维码](${qrCodeBase64})

**二维码链接：** ${testScanUrl}

**或直接访问：** [点击这里打开二维码](${testScanUrl})

> 这是一条测试消息，用于验证webhook推送功能是否正常。`;

  try {
    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: '微信读书账号失效通知（测试）',
        text: markdownText,
      },
    };

    console.log('正在发送测试消息到钉钉...');
    const response = await Axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10 * 1e3,
    });

    console.log('✅ 测试消息发送成功！');
    console.log('响应:', response.data);
  } catch (error: any) {
    console.error('❌ 发送markdown消息失败:', error.message);
    
    // 如果markdown格式失败，尝试发送文本消息
    try {
      const textPayload = {
        msgtype: 'text',
        text: {
          content: `微信读书账号失效通知（测试）\n\n账号ID: TEST_ACCOUNT_ID\n账号名称: 测试微信账号\n失效时间: ${beijingTime}\n\n请扫描二维码重新登录微信账号: ${testScanUrl}`,
        },
      };
      
      console.log('尝试发送文本消息...');
      const textResponse = await Axios.post(webhookUrl, textPayload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10 * 1e3,
      });
      
      console.log('✅ 文本消息发送成功！');
      console.log('响应:', textResponse.data);
    } catch (textError: any) {
      console.error('❌ 发送文本消息也失败:', textError.message);
      if (textError.response) {
        console.error('响应数据:', textError.response.data);
      }
    }
  }
}

// 执行测试
testWebhook().catch(console.error);

