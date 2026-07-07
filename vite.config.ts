import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import http from 'http';
import https from 'https';

// 自定义 CORS 代理插件
function corsProxyPlugin(): Plugin {
    return {
        name: 'cors-proxy',
        configureServer(server) {
            // 处理 OPTIONS 预检请求 - 必须放在前面
            server.middlewares.use('/cors-proxy', (req, res, next) => {
                // 添加 CORS 头
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', '*');
                
                if (req.method === 'OPTIONS') {
                    res.statusCode = 204;
                    res.end();
                    return;
                }
                next();
            });

            server.middlewares.use('/cors-proxy', (req, res) => {
                const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url');
                if (!urlParam) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'Missing url parameter' }));
                    return;
                }

                try {
                    const targetUrl = new URL(decodeURIComponent(urlParam));
                    const isHttps = targetUrl.protocol === 'https:';
                    const httpModule = isHttps ? https : http;

                    // 构建转发请求的 headers
                    const headers: Record<string, string | string[] | undefined> = {};
                    for (const [key, value] of Object.entries(req.headers)) {
                        const lowerKey = key.toLowerCase();
                        if (lowerKey !== 'host' && 
                            lowerKey !== 'origin' && 
                            lowerKey !== 'referer' &&
                            lowerKey !== 'connection' &&
                            value) {
                            headers[key] = value;
                        }
                    }
                    headers['host'] = targetUrl.host;

                    const proxyReq = httpModule.request(
                        {
                            hostname: targetUrl.hostname,
                            port: targetUrl.port || (isHttps ? 443 : 80),
                            path: targetUrl.pathname + targetUrl.search,
                            method: req.method,
                            headers,
                            timeout: 120000,
                        },
                        (proxyRes) => {
                            // 设置响应状态码
                            res.statusCode = proxyRes.statusCode || 500;
                            
                            // 复制响应头
                            for (const [key, value] of Object.entries(proxyRes.headers)) {
                                if (value && !['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                                    res.setHeader(key, value);
                                }
                            }
                            
                            // 确保 CORS 头存在
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            
                            // 管道传输响应
                            proxyRes.pipe(res);
                        }
                    );

                    proxyReq.on('error', (error) => {
                        console.error('[CORS Proxy] Request error:', error.message);
                        if (!res.headersSent) {
                            res.statusCode = 502;
                            res.end(JSON.stringify({ error: `Proxy error: ${error.message}` }));
                        }
                    });

                    proxyReq.on('timeout', () => {
                        console.error('[CORS Proxy] Request timeout');
                        proxyReq.destroy();
                        if (!res.headersSent) {
                            res.statusCode = 504;
                            res.end(JSON.stringify({ error: 'Proxy timeout' }));
                        }
                    });

                    // 管道传输请求体
                    req.pipe(proxyReq);
                } catch (error: any) {
                    console.error('[CORS Proxy] Error:', error.message);
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
        }
    };
}

function directorDeskStaticIndexPlugin(): Plugin {
    return {
        name: 'director-desk-static-index',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const requestPath = (req.url || '').split('?')[0];
                if (requestPath !== '/director-desk' && requestPath !== '/director-desk/') {
                    next();
                    return;
                }

                const indexPath = path.resolve(__dirname, 'public/director-desk/index.html');
                if (!fs.existsSync(indexPath)) {
                    next();
                    return;
                }

                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(fs.readFileSync(indexPath));
            });
        }
    };
}

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: 'localhost',
        proxy: {
          '/api': {
            target: 'http://127.0.0.1:8787',
            changeOrigin: true,
          }
        }
      },
      plugins: [react(), directorDeskStaticIndexPlugin(), corsProxyPlugin()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
