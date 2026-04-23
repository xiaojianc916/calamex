# 技术债务登记

> 按 R-17.3.5：`TODO`/`FIXME` MUST 带责任人 + 截止日期。
> 按 R-3.2.1：any 豁免 MUST 在此登记含截止日期。

---

## 格式

```
| ID | 描述 | 负责人 | 截止迭代 | ADR/规则 | 状态 |
```

---

## 活跃条目

| ID | 描述 | 负责人 | 截止迭代 | 规则 | 状态 |
|---|---|---|---|---|---|
| TD-0001 | `useWorkbench.ts` 行数超 R-20.1.3 限(≤400) | xiaojianc | 2026-06-30 | R-20.1.3 | 🔴 豁免期内 |
| TD-0002 | `ShellWorkbenchView.vue` `<script setup>` 超 R-20.1.4 限(≤120) | xiaojianc | 2026-06-30 | R-20.1.4 | 🔴 豁免期内 |
| TD-0003 | `useIntegratedTerminal.ts` 待按 R-20.2.1 拆分为 session + registry | xiaojianc | 2026-06-30 | R-20.2.* | 🔴 豁免期内 |
| TD-0004 | `main.ts` 内联 DOM 超 R-20.6.3 限(≤120) | xiaojianc | 2026-06-30 | R-20.6.3 | 🔴 豁免期内 |
| TD-0005 | `commands/mod.rs` 超 R-20.5.1 限(≤80) | xiaojianc | 2026-08-31 | R-20.5.1 | 🔴 豁免期内 |
| TD-0006 | `style-src 'unsafe-inline'` CSP 放宽，需迁移到 nonce(参见 ADR-0004) | xiaojianc | 2026-08-31 | R-7.5.2 | 🟡 已登记 |
| TD-0007 | `src/router/` 为休眠模块，src/router/index.ts 未挂载 | xiaojianc | 按需 | ADR-0006 | 🟡 有意为之 |
| TD-0008 | 若未来切换到无边框自绘标题栏，需替代 ADR-20260422 的原生边框底色治理路径并重新评估 resize 行为 | xiaojianc | 按需 | ADR-20260422-window-resize-tearing | 🟡 观察中 |
| TD-0009 | `pnpm lint` 仍存在既有 Vue `first-attribute-linebreak` 格式 warning，需独立格式化修复，避免混入 visual-hosting 原子提交 | xiaojianc | 2026-06-30 | G-5 / R-17.3.5 | 🟡 已登记 |

---

## 已关闭条目

*暂无*
