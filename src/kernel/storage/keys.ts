/** 所有持久化 key 集中在这里，避免各层各写一遍字符串（§6.5、§11） */
export const STORAGE_KEYS = {
  /** chrome.storage.local：全局设置 */
  settings: 'settings',
  /** chrome.storage.local：UI 偏好（按站点） */
  shellPrefs: 'shell.prefs',
  /** chrome.storage.local：功能私有设置，前缀 + 功能 id */
  featureSettings: (id: string) => `feature:${id}`,
  /** chrome.storage.session：任务镜像 */
  jobMirror: 'jobs.mirror',
  /** chrome.storage.session：待续接的下载意图（5 分钟过期） */
  pendingIntent: 'jobs.pendingIntent',
  /** chrome.storage.session：grant 小窗 windowId */
  grantWindowId: 'fs.grantWindowId',
  /** IndexedDB */
  dbName: 'ecbox',
  dbVersion: 1,
  stores: {
    handles: 'handles',
    folders: 'folders',
    logs: 'logs',
    downloads: 'downloads',
  },
} as const;

export const PENDING_INTENT_TTL_MS = 5 * 60 * 1000;
