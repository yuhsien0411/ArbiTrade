/**
 * 前端代理配置
 * 只代理 API 请求到后端，避免热更新文件被代理
 */
const { createProxyMiddleware } = require('http-proxy-middleware');

const apiPort = process.env.REACT_APP_API_PORT || '7001';
const apiTarget = process.env.REACT_APP_API_URL || `http://127.0.0.1:${apiPort}`;

module.exports = function(app) {
  // 只代理 /api 和 /status 开头的请求
  app.use(
    ['/api', '/status', '/health', '/ws'],
    createProxyMiddleware({
      target: apiTarget,
      changeOrigin: true,
      ws: true,
      logLevel: 'silent', // 减少日志输出
    })
  );
};
