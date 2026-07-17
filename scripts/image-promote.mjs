#!/usr/bin/env node
/* eslint-disable harness/no-sql-concatenation */
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Image Promote (CICD.md Build Once Deploy Many)
//
// 严格 retag：不重建镜像，仅打新 tag 并写入 OCI label。
// 唯一允许 rebuild 的例外是 hotfix（且必须明确 --force-rebuild）。
//
// 用法:
//   image-promote.mjs --from <tag> --to <tag> [--registry <url>] [--dry-run]
//   image-promote.mjs --force-rebuild --hotfix <issue-id> --tag <tag>   # 仅 hotfix
// =============================================================================

import { info, ok, err, fatal, warn, run, tryRun, runCapture, hasCmd } from './lib/utils.mjs';
import { resolveDeliveryMode } from './lib/delivery-mode.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
    }
  }
  return out;
}

function ociLabels({ from, to }) {
  const sourceSha = runCapture('git rev-parse --short HEAD', { ignoreError: true }) || 'unknown';
  const sourceBranch = runCapture('git rev-parse --abbrev-ref HEAD', { ignoreError: true }) || 'unknown';
  const promotedBy = process.env.GITHUB_ACTOR || process.env.GITLAB_USER_LOGIN || process.env.USER || 'unknown';
  return [
    `org.harness.source-branch=${sourceBranch}`,
    `org.harness.source-sha=${sourceSha}`,
    `org.harness.promoted-from=${from}`,
    `org.harness.promoted-by=${promotedBy}`,
    `org.harness.promoted-at=${new Date().toISOString()}`,
    `org.harness.target-tag=${to}`,
  ];
}

function imageRef(registry, tag) {
  const repo = process.env.HARNESS_IMAGE_REPO;
  if (!repo) fatal('环境变量 HARNESS_IMAGE_REPO 未设置（如 ghcr.io/org/app）');
  return registry ? `${registry}/${repo}:${tag}` : `${repo}:${tag}`;
}

function resolveRegistryMode() {
  // Sprint 12 T-04/T-05：薄包装 → lib/delivery-mode.mjs，统一新旧名解析与 warn。
  return resolveDeliveryMode();
}

function promoteArtifact({ from, to, fromTar, toTar, dryRun }) {
  if (!fromTar) fatal('artifact 模式 promote 需要 --from-tar <path>');
  const target = toTar || fromTar.replace(new RegExp(`${from}(\\.tar)$`), `${to}$1`) || `${to}.tar`;
  info(`promote(artifact): ${fromTar} (${from}) → ${target} (${to})`);
  if (dryRun) {
    info(`[dry-run] docker load -i ${fromTar}`);
    info(`[dry-run] docker tag <loaded>:${from} <loaded>:${to}`);
    info(`[dry-run] docker save -o ${target} <loaded>:${to}`);
    return;
  }
  if (!hasCmd('docker')) fatal('docker 未安装');
  const loadOut = runCapture(`docker load -i ${fromTar}`);
  // docker load 输出：Loaded image: repo:tag\n
  const loaded = [...loadOut.matchAll(/Loaded image: ([^\s]+)/g)].map((m) => m[1]);
  if (loaded.length === 0) fatal(`无法从 ${fromTar} 解析镜像名`);
  const retagged = loaded.map((ref) => {
    const dst = ref.replace(new RegExp(`:${from}$`), `:${to}`);
    if (dst === ref) {
      warn(`镜像 ${ref} 不含 :${from}，强制 retag 为 ${ref.replace(/:[^:]*$/, `:${to}`)}`);
    }
    const finalDst = dst === ref ? ref.replace(/:[^:]*$/, `:${to}`) : dst;
    run(`docker tag ${ref} ${finalDst}`);
    return finalDst;
  });
  run(`docker save -o ${target} ${retagged.join(' ')}`);
  ok(`已 promote(artifact)：${target}`);
}

function promote({ from, to, registry, dryRun, fromTar, toTar }) {
  if (resolveRegistryMode() === 'artifact') {
    return promoteArtifact({ from, to, fromTar, toTar, dryRun });
  }
  if (!hasCmd('docker')) fatal('docker 未安装');
  const src = imageRef(registry, from);
  const dst = imageRef(registry, to);
  const labels = ociLabels({ from, to });
  // prod-* 目标强制 buildx imagetools，确保 OCI label 写入（CICD.md R1 promotion 链）
  const isProd = /^prod-/.test(to);
  const buildxOk = hasCmd('docker') && tryRun('docker buildx imagetools --help', { ignoreError: true }).ok;
  if (isProd && !buildxOk) {
    fatal('prod-* promote 必须使用 docker buildx imagetools（OCI label 不可缺）；请安装/启用 buildx');
  }

  info(`promote: ${src} → ${dst}`);
  if (dryRun) {
    info(`[dry-run] docker pull ${src}`);
    info(`[dry-run] docker tag ${src} ${dst}`);
    for (const l of labels) info(`[dry-run] label: ${l}`);
    info(`[dry-run] docker push ${dst}`);
    return;
  }

  run(`docker pull ${src}`);
  if (buildxOk) {
    const labelArgs = labels.map(l => `--annotation "${l}"`).join(' ');
    run(`docker buildx imagetools create ${labelArgs} -t ${dst} ${src}`);
  } else {
    warn('docker buildx imagetools 不可用，回退到 docker tag（仅 dev/test，不写 OCI label）');
    run(`docker tag ${src} ${dst}`);
    run(`docker push ${dst}`);
  }
  ok(`已 promote：${dst}`);
}

function forceRebuild({ tag, hotfix, registry }) {
  if (!hotfix) fatal('--force-rebuild 仅在 --hotfix <issue-id> 模式下允许（CICD.md）');
  if (!tag) fatal('--tag 必填');
  // tag 必须以 prod-hotfix-<issue> 前缀，避免 hotfix 走 dev/test/release tag 通道
  if (!/^prod-hotfix-/.test(tag)) {
    fatal(`--tag 必须以 prod-hotfix- 前缀（当前：${tag}）`);
  }
  if (!tag.includes(String(hotfix))) {
    fatal(`--tag 必须包含 issue 标识 ${hotfix}（当前：${tag}）`);
  }
  const dst = imageRef(registry, tag);
  warn(`hotfix 强制重建：${dst}（issue=${hotfix}）`);
  run(`docker build -t ${dst} --label org.harness.hotfix=${hotfix} --label org.harness.rebuilt-at=${new Date().toISOString()} .`);
  run(`docker push ${dst}`);
  ok(`hotfix 镜像已发布：${dst}`);
}

function showHelp() {
  console.log(`
Harness Image Promote — Build Once Deploy Many

  image-promote.mjs --from <tag> --to <tag> [--registry <url>] [--dry-run]
  image-promote.mjs --force-rebuild --hotfix <issue-id> --tag <tag>

详见 docs/CICD.md。
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) { showHelp(); process.exit(0); }

if (args['force-rebuild']) {
  forceRebuild({ tag: args.tag, hotfix: args.hotfix, registry: args.registry });
} else {
  if (!args.from || !args.to) { showHelp(); fatal('--from 与 --to 必填'); }
  promote({ from: args.from, to: args.to, registry: args.registry, dryRun: !!args['dry-run'], fromTar: args['from-tar'], toTar: args['to-tar'] });
}
