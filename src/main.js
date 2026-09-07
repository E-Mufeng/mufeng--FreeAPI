// main.js — Free API 工作台 · Vite 应用入口（Phase 1b 模块化）
// 职责：按依赖顺序装配模块。
// 1) 先注入内嵌目录（catalog-embedded.js 在导入时把 window.EMBEDDED_CATALOG 设为数组，
//    必须在 app.js 求值前完成，app.js 运行时读取该全局）。
// 2) 导入主应用逻辑（src/app.js，已是 ESM 模块，导入各子模块并启动）。
// 3) 导入全局样式（Vite 会将其打包进产物 CSS）。
import '../catalog/catalog-embedded.js';
import './app.js';
import './styles/main.css';
