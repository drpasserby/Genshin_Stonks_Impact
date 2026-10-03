import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * 构建标记插件：往 index.html 里塞一行 HTML 注释。
 *
 * 为什么需要它：前端是 SPA，浏览器只要还拿着**旧页面**（缓存/未强刷），
 * 就会去请求旧版本的 chunk；如果那些 chunk 已被清理，nginx 的 SPA 回退会把
 * index.html 当 JS 返回 → "MIME type text/html" 报错 → 整页白屏。
 * 出问题时第一件事就是确认「用户拿到的是哪一版」，没有标记只能靠猜。
 */
function buildMarker() {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return {
    name: 'teyvat-build-marker',
    transformIndexHtml(html: string) {
      return html.replace(
        '</head>',
        `  <!-- BUILD: v${pkg.version} @ ${stamp} -->\n  </head>`,
      );
    },
  };
}

// 开发时把 /api 代理到后端（3000）
export default defineConfig({
  plugins: [vue(), buildMarker()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          'element-plus': ['element-plus'],
        },
      },
    },
  },
});
