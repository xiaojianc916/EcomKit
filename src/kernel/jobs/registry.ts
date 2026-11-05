import { EcError } from '../errors/ec-error';
import type { JobTypeDef } from './types';

/**
 * 任务类型注册表（方案 §6.4、§8.3）。
 *
 * 功能模块在 engine.ts 里声明 JobTypeDef，启动时统一注册。
 * 为什么启动时就要校验 type 不重复：两个功能抢同一个 type 会让提交的任务跑错实现，
 * 而且症状非常隐蔽 —— 进度能走完，文件却写到了别的地方。宁可启动就炸。
 */

export interface JobTypeRegistry {
  register(def: JobTypeDef<any, any>): void;
  /** 批量注册；先把重复项全找出来再一次报错，方便一次看到所有冲突 */
  registerAll(defs: readonly JobTypeDef<any, any>[]): void;
  get(type: string): JobTypeDef<any, any> | undefined;
  /** 取不到时抛错（提交任务时用，避免静默什么都不做） */
  require(type: string): JobTypeDef<any, any>;
  has(type: string): boolean;
  /** 已注册的类型（排序后），启动自检和日志用 */
  registeredTypes(): string[];
  clear(): void;
}

export function createJobRegistry(): JobTypeRegistry {
  const defs = new Map<string, JobTypeDef<any, any>>();

  const registry: JobTypeRegistry = {
    register(def) {
      if (!def.type) throw new EcError('INTERNAL', { reason: 'job-type-empty' });
      if (defs.has(def.type)) {
        throw new EcError('INTERNAL', { reason: 'job-type-duplicate', detail: def.type });
      }
      defs.set(def.type, def);
    },
    registerAll(list) {
      const duplicates = new Set<string>();
      const seen = new Set<string>();
      for (const def of list) {
        if (!def.type) throw new EcError('INTERNAL', { reason: 'job-type-empty' });
        if (seen.has(def.type) || defs.has(def.type)) duplicates.add(def.type);
        seen.add(def.type);
      }
      if (duplicates.size > 0) {
        throw new EcError('INTERNAL', {
          reason: 'job-type-duplicate',
          detail: [...duplicates].join(', '),
        });
      }
      for (const def of list) defs.set(def.type, def);
    },
    get(type) {
      return defs.get(type);
    },
    require(type) {
      const def = defs.get(type);
      if (!def) throw new EcError('INTERNAL', { reason: 'unknown-job-type', detail: type });
      return def;
    },
    has(type) {
      return defs.has(type);
    },
    registeredTypes() {
      return [...defs.keys()].sort();
    },
    clear() {
      defs.clear();
    },
  };

  return registry;
}

/** 全局单例：offscreen 启动时注册一次；单测里可以 clear() */
export const jobRegistry = createJobRegistry();
