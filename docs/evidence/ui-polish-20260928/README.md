# UI 细节复核 · 2026-09-28

版本 2.4.23-ui-polish。全部使用隔离临时库、虚构资产及默认分类；未读取或改写个人账本。

- 全量 Node 测试 648/648，见 full-test.txt。
- 最终全新 origin 18822：原浏览器接线 34/34；1440/1100/390px × 17 页共 51 项检查通过，见 result.json。
- 月份标题检查宽高不裁切，前后切换恢复原月份；分类、账户、筛选弹层无溢出与表情。
- 1440/390px 分类保存验证：已有名称、关键词及 icon 字段保留；原有保存逻辑会把缺省 parentId/necessity 规范化为 null。
- 调试时曾在已修改分类的 18821 预览库复跑整套 harness，得到 32/34；最终重新创建临时库和 origin 后 34/34。每次复跑 check.py 应使用全新 fixture 服务。

复跑：先启动 node docs/evidence/phase5d-wiring-server.cjs <新端口>，再运行 python3 docs/evidence/ui-polish-20260928/check.py <新端口>。
