export const TOKEN = '00000000-0000-4000-8000-000000000000';

export const TOKEN_OK = { success: true, message: '', result: {
  scope: 'everything', expiration: 1_900_000_000, created: 1_700_000_000,
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
