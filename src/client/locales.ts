import type { ClientErrorCode } from './http.js';

export const zh = {
  title: 'V2EX', loginLabel: 'V2EX Personal Access Token', login: '登录', loginHelp: '令牌仅用于本次登录，由 DSH 凭据服务保存。',
  latest: '最新', hot: '热门', nodes: '节点', nodeLabel: '节点名称', nodePlaceholder: '输入节点名称', browse: '浏览',
  logout: '退出登录', clearPersonalData: '同时清除个人数据', reload: '刷新', retry: '重试', back: '返回列表',
  loading: '加载中…', empty: '暂无主题', repliesEmpty: '暂无回复', loadMore: '加载更多', moreReplies: '加载更多回复',
  stale: '显示缓存内容，数据可能已过期', page: '第', replies: '页回复',
  topicList: '主题列表', topicDetail: '主题详情', viewTabs: '浏览视图', replyHeading: '回复', replyCount: '条回复',
  errors: {
    not_authenticated: '请先登录 V2EX。', token_invalid: '令牌无效，请更换后重试。', token_expired: '令牌已过期，请重新登录。',
    rate_limited: '请求过于频繁，请稍后重试。', offline: '网络不可用，请检查连接。', timeout: '请求超时，请重试。',
    not_found: '内容不存在或已删除。', invalid_request: '输入有误，请检查后重试。', invalid_response: '返回内容异常，请稍后重试。',
    upstream: 'V2EX 暂时无法完成请求。', ai_unavailable: '智能功能暂不可用。', history_access_denied: '未授权读取历史记录。',
    budget_exhausted: '请求额度已用完，请稍后重试。', incompatible_runtime: 'DSH 运行环境不兼容。', cancelled: '请求已取消。',
  } satisfies Record<ClientErrorCode, string>,
};

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
