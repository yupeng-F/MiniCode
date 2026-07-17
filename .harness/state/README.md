# .harness/state/

CI/CD 运行时状态目录（原 `state/`，已于 v1.6 迁移至此）。

| 文件 | 写入者 | 说明 |
|------|--------|------|
| `test-env.lock` | `scripts/lock.mjs` | Test 环境互斥锁（SPRINT.md §发布编排） |
| `promotion-log.yml` | `scripts/promote.mjs` | 镜像与分支提升历史 |
| `harness-version.txt` | `install.sh` | 上次框架同步戳（ref / timestamp / branch） |
| `acceptance/*.yml` | `scripts/acceptance-record.mjs` | L3 走查审批记录 |

约束：
- 文件由脚本管理；人手修改前先 `lock check`。
- `test-env.lock` 在 promote / release CD 之间互斥。
- TTL 默认 7200 秒，过期自动释放。
