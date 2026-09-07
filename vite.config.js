import { defineConfig } from 'vite';

// Free API 工作台 · Vite 构建配置（Phase 1b 模块化）
// 以根目录 index.html 为入口；base './' 保证产物可放任意子路径或 file 部署。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2018',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1200
  },
  server: {
    // 本地开发：FREEAPI_DEV=1 时代理回退读源码根；这里仅作 vite dev 预览用
    port: 5173,
    strictPort: false
  }
});
