import type { ClientErrorCode } from './http.js';

export interface Copy {
  title: string; loginLabel: string; login: string; loginHelp: string;
  latest: string; hot: string; nodes: string; nodeLabel: string; nodePlaceholder: string; browse: string;
  logout: string; clearPersonalData: string; reload: string; retry: string; back: string;
  loading: string; empty: string; noMatches: string; repliesEmpty: string; loadMore: string; moreReplies: string;
  stale: string; page: string; replies: string; topicList: string; topicDetail: string; viewTabs: string;
  replyHeading: string; replyCount: string; tokenScope: string; expiresAt: string; replaceToken: string;
  keyword: string; filterNode: string;
  aiSummary: string; summaryMode: string; summaryModes: Record<'quick' | 'viewpoints' | 'full', string>;
  generateSummary: string; regenerateSummary: string; generatingSummary: string; notableReplies: string;
  generatedAt: string; coverageTemplate: string; coveredPageListTemplate: string; incompleteSummary: string;
  interests: string; historyConsent: string; authorizeHistory: string; relearn: string; pauseLearning: string; resumeLearning: string;
  interestLabels: string; preferredNodes: string; exclusions: string; saveInterests: string; invalidInterestEdit: string;
  revokeHistory: string; confirmRevokeHistory: string; clearInterests: string; confirmClearInterests: string;
  settings: string; refreshInterval: string; pagesPerNode: string; candidateBudget: string; modelCallBudget: string;
  scannedNodes: string; notificationThresholdTemplate: string; quietHours: string; enableQuietHours: string;
  quietStart: string; quietEnd: string; timeZone: string; invalidSettings: string; saveSettings: string; saving: string;
  smartRecommendations: string; smartUnreadTemplate: string; recommendationSource: string; sourceStored: string; sourceGenerated: string;
  noRecommendations: string; unread: string; interested: string; notInterested: string;
  errors: Record<ClientErrorCode, string>;
}

export const zh: Copy = {
  title: 'V2EX', loginLabel: 'V2EX Personal Access Token', login: '登录', loginHelp: '令牌仅用于本次登录，由 DSH 凭据服务保存。',
  latest: '最新', hot: '热门', nodes: '节点', nodeLabel: '节点名称', nodePlaceholder: '输入节点名称', browse: '浏览',
  logout: '退出登录', clearPersonalData: '同时清除个人数据', reload: '刷新', retry: '重试', back: '返回列表',
  loading: '加载中…', empty: '暂无主题', noMatches: '没有匹配的主题', repliesEmpty: '暂无回复', loadMore: '加载更多', moreReplies: '加载更多回复',
  stale: '显示缓存内容，数据可能已过期', page: '第', replies: '页回复',
  topicList: '主题列表', topicDetail: '主题详情', viewTabs: '浏览视图', replyHeading: '回复', replyCount: '条回复',
  tokenScope: '令牌权限', expiresAt: '有效期至', replaceToken: '更换令牌', keyword: '关键词', filterNode: '筛选节点',
  aiSummary: 'AI 总结', summaryMode: '总结模式', summaryModes: { quick: '快速总结', viewpoints: '观点与争议', full: '重点回复' },
  generateSummary: '生成总结', regenerateSummary: '重新生成总结', generatingSummary: '正在生成总结', notableReplies: '重点回复',
  generatedAt: '生成时间', coverageTemplate: '已覆盖 {loaded}/{total} 页回复', coveredPageListTemplate: '已覆盖回复页：{pages}', incompleteSummary: '内容并非完整讨论归纳',
  interests: '兴趣管理', historyConsent: '授权后只读取你的历史用户消息，提取结构化兴趣；不保存原始历史，可随时暂停、撤销或清除。',
  authorizeHistory: '授权读取历史并学习', relearn: '重新学习', pauseLearning: '暂停自动学习', resumeLearning: '恢复自动学习',
  interestLabels: '兴趣标签', preferredNodes: '偏好节点', exclusions: '排除内容', saveInterests: '保存兴趣设置', invalidInterestEdit: '请使用“名称:权重”的格式，权重范围为 0 到 1。',
  revokeHistory: '撤销历史授权', confirmRevokeHistory: '确认撤销历史授权', clearInterests: '清除兴趣与推荐数据', confirmClearInterests: '确认清除兴趣与推荐数据',
  settings: '设置', refreshInterval: '刷新间隔（分钟）', pagesPerNode: '每节点页数', candidateBudget: '候选主题上限', modelCallBudget: '每次刷新模型调用上限',
  scannedNodes: '扫描节点', notificationThresholdTemplate: '通知阈值：{value}%', quietHours: '静默时段', enableQuietHours: '启用静默时段',
  quietStart: '开始时间', quietEnd: '结束时间', timeZone: '时区', invalidSettings: '设置值超出允许范围，请检查后重试。', saveSettings: '保存设置', saving: '正在保存',
  smartRecommendations: '智能推荐', smartUnreadTemplate: '智能推荐，{count} 条未读', recommendationSource: '来源：', sourceStored: '已保存', sourceGenerated: '刚刚生成',
  noRecommendations: '暂无智能推荐', unread: '未读', interested: '感兴趣', notInterested: '不感兴趣',
  errors: {
    not_authenticated: '请先登录 V2EX。', token_invalid: '令牌无效，请更换后重试。', token_expired: '令牌已过期，请重新登录。',
    rate_limited: '请求过于频繁，请稍后重试。', offline: '网络不可用，请检查连接。', timeout: '请求超时，请重试。',
    not_found: '内容不存在或已删除。', invalid_request: '输入有误，请检查后重试。', invalid_response: '返回内容异常，请稍后重试。',
    upstream: 'V2EX 暂时无法完成请求。', ai_unavailable: '智能功能暂不可用。', history_access_denied: '未授权读取历史记录。',
    budget_exhausted: '请求额度已用完，请稍后重试。', incompatible_runtime: 'DSH 运行环境不兼容。', cancelled: '请求已取消。',
  },
};

export const en: Copy = {
  title: 'V2EX', loginLabel: 'V2EX Personal Access Token', login: 'Log in', loginHelp: 'The token is used for this sign-in and saved by DSH Credentials.',
  latest: 'Latest', hot: 'Hot', nodes: 'Nodes', nodeLabel: 'Node name', nodePlaceholder: 'Enter a node', browse: 'Browse',
  logout: 'Log out', clearPersonalData: 'Also clear personal data', reload: 'Refresh', retry: 'Retry', back: 'Back to topics',
  loading: 'Loading…', empty: 'No topics', noMatches: 'No matching topics', repliesEmpty: 'No replies', loadMore: 'Load more', moreReplies: 'Load more replies',
  stale: 'Showing cached content that may be outdated', page: 'Page', replies: 'replies',
  topicList: 'Topic list', topicDetail: 'Topic detail', viewTabs: 'Browse views', replyHeading: 'Replies', replyCount: 'replies',
  tokenScope: 'Token scope', expiresAt: 'Expires', replaceToken: 'Replace token', keyword: 'Keyword', filterNode: 'Filter node',
  aiSummary: 'AI summary', summaryMode: 'Summary mode', summaryModes: { quick: 'Quick summary', viewpoints: 'Viewpoints', full: 'Notable replies' },
  generateSummary: 'Generate summary', regenerateSummary: 'Regenerate summary', generatingSummary: 'Generating summary', notableReplies: 'Notable replies',
  generatedAt: 'Generated', coverageTemplate: 'Covered {loaded}/{total} reply pages', coveredPageListTemplate: 'Covered reply pages: {pages}', incompleteSummary: 'This is not a complete discussion summary',
  interests: 'Interests', historyConsent: 'When authorized, only your historical user messages are read to extract structured interests. Raw history is not stored, and access can be paused, revoked, or cleared.',
  authorizeHistory: 'Authorize history learning', relearn: 'Relearn', pauseLearning: 'Pause automatic learning', resumeLearning: 'Resume automatic learning',
  interestLabels: 'Interest labels', preferredNodes: 'Preferred nodes', exclusions: 'Exclusions', saveInterests: 'Save interests', invalidInterestEdit: 'Use name:weight with weights between 0 and 1.',
  revokeHistory: 'Revoke history access', confirmRevokeHistory: 'Confirm revoke history access', clearInterests: 'Clear interests and recommendations', confirmClearInterests: 'Confirm clear interests and recommendations',
  settings: 'Settings', refreshInterval: 'Refresh interval (minutes)', pagesPerNode: 'Pages per node', candidateBudget: 'Candidate topic limit', modelCallBudget: 'Model calls per refresh',
  scannedNodes: 'Scanned nodes', notificationThresholdTemplate: 'Notification threshold: {value}%', quietHours: 'Quiet hours', enableQuietHours: 'Enable quiet hours',
  quietStart: 'Start time', quietEnd: 'End time', timeZone: 'Time zone', invalidSettings: 'One or more settings are outside the allowed range.', saveSettings: 'Save settings', saving: 'Saving',
  smartRecommendations: 'Smart recommendations', smartUnreadTemplate: 'Smart recommendations, {count} unread', recommendationSource: 'Source: ', sourceStored: 'Stored', sourceGenerated: 'Just generated',
  noRecommendations: 'No smart recommendations yet', unread: 'Unread', interested: 'Interested', notInterested: 'Not interested',
  errors: {
    not_authenticated: 'Log in to V2EX first.', token_invalid: 'The token is invalid. Replace it and retry.', token_expired: 'The token expired. Log in again.',
    rate_limited: 'Too many requests. Try again later.', offline: 'Network unavailable. Check your connection.', timeout: 'The request timed out. Retry.',
    not_found: 'Content was not found.', invalid_request: 'Check your input and retry.', invalid_response: 'Unexpected response. Try again later.',
    upstream: 'V2EX could not complete the request.', ai_unavailable: 'AI features are unavailable.', history_access_denied: 'History access is not authorized.',
    budget_exhausted: 'Request budget exhausted. Try again later.', incompatible_runtime: 'The DSH runtime is incompatible.', cancelled: 'Request cancelled.',
  },
};

export type LocaleKey = Exclude<keyof Copy, 'errors' | 'summaryModes'> | `summaryModes.${keyof Copy['summaryModes']}` | `errors.${ClientErrorCode}`;
export const LOCALE_NS = 'v2ex';
export function dictionary(copy: Copy): Record<LocaleKey, string> {
  return Object.fromEntries([
    ...Object.entries(copy).filter(([key]) => key !== 'errors' && key !== 'summaryModes'),
    ...Object.entries(copy.summaryModes).map(([key, value]) => [`summaryModes.${key}`, value]),
    ...Object.entries(copy.errors).map(([key, value]) => [`errors.${key}`, value]),
  ]) as Record<LocaleKey, string>;
}
export interface LocaleSource {
  getSnapshot(): { active: string };
  subscribe(listener: () => void): () => void;
}
export function copyFor(active: string): Copy { return active.toLowerCase().startsWith('zh') ? zh : en; }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { v2ex: LocaleKey }
}

export function formatTime(value: string, locale = 'zh'): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
