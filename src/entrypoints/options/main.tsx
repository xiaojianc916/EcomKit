import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 设置页和工具箱面板共用同一批表单组件（shell/settings/sections.tsx），
// 那些组件用的是 ec-* 类和 var(--ec-*) 令牌 —— 不引这两份样式，独立页面里会变成无样式的裸控件。
import '../../kernel/ui-kit/tokens.css';
import '../../kernel/ui-kit/ui-kit.css';
import { OptionsApp } from './OptionsApp';
import './options.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
