-- Migration: <id>-<slug>.up.sql
-- Description: <one-line business rationale>
-- Reversible: true | false
-- Forward-Compatible: true | false
-- Author: <name>
-- Created: <YYYY-MM-DD>

BEGIN;

-- 正向变更使用幂等守卫（IF NOT EXISTS / IF EXISTS）
-- 大表变更采用 LIMIT 分批

COMMIT;
