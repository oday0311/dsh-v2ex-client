export const TOKEN = '00000000-0000-4000-8000-000000000000';

export const TOKEN_OK = { success: true, message: '', result: {
  scope: 'everything', expiration: 2_592_000, good_for_days: 30, created: 1_794_000_000,
} };

export const MEMBER_OK = { success: true, message: '', result: {
  id: 42, username: 'alice', url: 'https://www.v2ex.com/member/alice',
  website: '', twitter: '', psn: '', github: '', btc: '', location: '', tagline: '',
  bio: '', avatar_mini: '', avatar_normal: '', avatar_large: '', created: 1_700_000_000,
} };

export const NODE_OK = { success: true, message: '', result: {
  id: 1, name: 'python', title: 'Python', url: 'https://www.v2ex.com/go/python',
  topics: 1, created: 1_700_000_000, last_modified: 1_700_000_100,
} };

export const TOPIC = {
  id: 123, title: 'A topic', url: 'https://www.v2ex.com/t/123',
  content: 'Content', content_rendered: '<p>Content</p>',
  replies: 1, created: 1_700_000_000, last_modified: 1_700_000_100,
  last_touched: 1_700_000_100,
  node: NODE_OK.result, member: MEMBER_OK.result,
};

export const TOPIC_OK = { success: true, message: '', result: TOPIC };
export const TOPICS_OK = { success: true, message: '', result: [TOPIC] };
export const REPLIES_OK = { success: true, message: '', result: [{
  id: 12, content: 'Reply', content_rendered: '<p>Reply</p>',
  created: 1_700_000_100, last_modified: 1_700_000_100,
  member: MEMBER_OK.result,
}] };

/** Minimal server-rendered V2EX tab page: one replied topic and one fresh topic. */
export const TAB_HTML = `<!DOCTYPE html>
<html lang="en"><head><title>V2EX</title></head><body>
<div class="box"><div class="inner" id="Tabs"><a href="/?tab=tech" class="tab_current">Tech</a><a href="/?tab=jobs" class="tab">Jobs</a></div>
<div class="cell item"><table><tr>
<td width="48"><a href="/member/alice"><img class="avatar" src="/a.png" alt="alice" /></a></td><td width="10"></td>
<td width="auto"><span class="item_title"><a href="/t/101#reply3" class="topic-link" id="topic-link-101">TypeScript &amp; Node &lt;guide&gt;</a></span>
<div class="sep5"></div>
<span class="topic_info"><div class="votes"></div><a class="node" href="/go/python">Python</a> &nbsp;•&nbsp; <strong><a href="/member/alice">alice</a></strong> &nbsp;•&nbsp; <span title="2026-11-07 14:36:28 +08:00">6 mins ago</span> &nbsp;•&nbsp; Lastly replied by <strong><a href="/member/bob">bob</a></strong></span>
</td><td width="70" align="right"><a href="/t/101#reply3" class="count_livid">3</a></td>
</tr></table></div>
<div class="cell item"><table><tr>
<td width="48"><a href="/member/carol"><img class="avatar" src="/c.png" alt="carol" /></a></td><td width="10"></td>
<td width="auto"><span class="item_title"><a href="/t/102#reply0" class="topic-link" id="topic-link-102">A fresh topic</a></span>
<div class="sep5"></div>
<span class="topic_info"><div class="votes"></div><a class="node" href="/go/dev">Dev</a> &nbsp;•&nbsp; <strong><a href="/member/carol">carol</a></strong> &nbsp;•&nbsp; <span title="2026-11-07 13:00:00 +08:00">1 hour ago</span></span>
</td><td width="70" align="right"></td>
</tr></table></div>
<div class="sep20"></div>
</div>
</body></html>`;
