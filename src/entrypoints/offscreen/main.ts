/**
 * Offscreen 文档（方案 §4.2、ADR-1、ADR-5）。
 *
 * 它是**任务的真相源**：队列、进度、取消、续传全在这里。
 * Service Worker 随时会被回收，所以 SW 只存一份镜像。
 *
 * 同时它是唯一能做这些事的地方：用 IndexedDB 里的目录句柄写文件（FSA 在 SW 里不可用）、
 * OffscreenCanvas 转码、以及跑几百 MB 的流式下载（不受 SW 30 秒空闲回收影响）。
 *
 * 绝不渲染 UI。
 */
import { createFsGateway } from '../../kernel/fs/fs-gateway';
import { createFsaSink } from '../../kernel/fs/sinks/fsa';
import { createDownloadsSink } from '../../kernel/fs/sinks/downloads';
import { createMemorySink } from '../../kernel/fs/sinks/memory';
import { createJobRunner } from '../../kernel/jobs/runner';
import { createLogger } from '../../kernel/log/logger';
import { createMediaTools } from '../../kernel/media/convert';
import { createFetcher } from '../../kernel/net/fetcher';
import { onMessage, sendMessage } from '../../kernel/messaging/runtime';
import { readSettings } from '../../kernel/settings/store';
import { engineFeatures } from '../../features/registry.engine';

const log = createLogger('offscreen');

async function main(): Promise<void> {
  const settings = await readSettings();

  // 保存方式决定用哪个 sink（§11、§9.13）；E2E 用内存 sink 让 Playwright 能校验目录树
  const isE2E = Boolean((globalThis as { __ECBOX_E2E__?: boolean }).__ECBOX_E2E__);
  const sink = isE2E
    ? createMemorySink()
    : settings.save.mode === 'downloads'
      ? createDownloadsSink()
      : createFsaSink();

  const gateway = createFsGateway({ sink });
  const runner = createJobRunner({
    gateway,
    jobTypes: engineFeatures.flatMap((f) => f.engine?.jobTypes ?? []),
    log,
    concurrency: settings.jobs.concurrency,
    net: createFetcher(),
    media: createMediaTools(),
  });

  await runner.start(gateway);
  log.info('offscreen booting', {
    features: engineFeatures.length,
    types: runner.registeredTypes(),
    sink: sink.kind,
  });

  onMessage('engine.enqueue', async ({ data }) => {
    await runner.enqueue(data.job, data.payload);
  });

  onMessage('engine.cancel', async ({ data }) => {
    runner.cancel(data.jobId);
  });

  onMessage('engine.call', async ({ data }) => {
    const feature = engineFeatures.find((f) => f.manifest.id === data.feature);
    const method = feature?.engine?.methods?.[data.method];
    if (!method) throw new Error('no engine method ' + data.feature + '.' + data.method);
    return method(data.args, { gateway, log });
  });

  onMessage('engine.fsStatus', async () => gateway.status());
  onMessage('engine.fsChanged', async () => gateway.sink.refresh());

  // 进度只往 bg 推，bg 再分发到各 Tab 的 Port（§4.3 第 7、8 步）
  runner.onEvent((ev) => {
    void sendMessage('engine.event', ev).catch(() => {
      // bg 正在重启时发不出去，下一条 progress 会补上最新状态
    });
  });

  await sendMessage('engine.ready');
  log.info('offscreen ready');
}

void main().catch((e) => log.error('offscreen boot failed', e));
