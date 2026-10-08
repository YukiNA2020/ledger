# 内置使用说明验收（2026-10-01）

版本 `2.4.28-help`，schema v11。九章静态手册，入口：桌面侧栏、首页、「我的」。本轮只用临时 fixture，脚本退出时删除测试数据库，不使用真实账本。

- `baseline-test.txt` / `final-test.txt`：704/704，无失败或跳过。
- `wiring-run-19524.json`：39/39。`browser-audit-19525.json`：第二轮39/39及原三项审计，外部请求/页面异常为零。
- `width-result.json`：69 页面/弹层 + 5 状态，共74。
- `help-review.json`：29专项，含离线刷新、启动失败、键盘、搜索焦点、三档宽度、零账本写入与外部请求。
- `help-*.png` / `home-help-entry-1440.png`：虚构空账本截图。
- `wiring-run-19521.json`：首次失败保留（新检查在隐藏的应用骨架上不能聚焦），原38项全部通过。修正测试显示前提后19524/19525全绿。

复跑（使用空闲回环端口，脚本自动创建和销毁临时服务）：

```sh
node --test
python3 docs/evidence/help-20261001/run_wiring_6f.py 19524
python3 docs/evidence/help-20261001/run_width_6f.py 19522
python3 docs/evidence/help-20261001/help_review.py 19523
python3 docs/evidence/phase5-review-20260927/browser-review.py 19525
```

脚本需要已有的 Python Playwright/Chromium。Phase 7 两个月真实使用尚待用户实施，本轮不证明真实维护耗时或实机启动门禁。
