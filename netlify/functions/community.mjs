// 처음운동 커뮤니티 서버 (Netlify Functions + Netlify Blobs)
// 사이트가 부르는 주소: /api/community/me, /posts, /posts/:id, /posts/:id/comments, /comments/:id
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/community/*' };

const PAGE_SIZE = 12;      // 한 쪽에 보이는 글 수 (사이트 화면과 같아야 함)
const MAX_POSTS = 1000;    // 전체 글 수 상한 (도배 방지)
const MAX_COMMENTS = 200;  // 글 하나당 댓글 상한
const WRITE_GAP_MS = 10000; // 같은 사람이 연속으로 쓸 때 최소 간격 (10초)
const KINDS = ['question', 'experience', 'encouragement'];
const EXPERIENCES = ['beginner', 'experienced'];
const SPORTS = ['', '수영', '헬스', '필라테스', '요가', '탁구', '라인댄스', '기타'];

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const fail = (message, status = 400) => json({ error: message }, status);

// 로그인 대신, 브라우저마다 임의 번호를 쿠키로 심어 "내 글"을 구분합니다.
function readAuthor(req) {
  const m = /(?:^|;\s*)fe_author=([A-Za-z0-9-]{16,64})/.exec(req.headers.get('cookie') || '');
  return m ? m[1] : null;
}
const authorCookie = (id) =>
  `fe_author=${id}; Path=/; Max-Age=63072000; HttpOnly; Secure; SameSite=Lax`;

const text = (v, min, max) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= min && s.length <= max ? s : null;
};

function cleanPost(data) {
  const nickname = text(data.nickname, 1, 20), title = text(data.title, 3, 100), body = text(data.body, 5, 4000);
  if (!nickname) return { error: '별명을 1~20자로 적어주세요.' };
  if (!title) return { error: '제목을 3~100자로 적어주세요.' };
  if (!body) return { error: '내용을 5~4000자로 적어주세요.' };
  if (!KINDS.includes(data.kind)) return { error: '글 종류를 선택해 주세요.' };
  if (!EXPERIENCES.includes(data.experience)) return { error: '경험 여부를 선택해 주세요.' };
  const sport = SPORTS.includes(data.sport) ? data.sport : '';
  return { value: { nickname, title, body, kind: data.kind, experience: data.experience, sport } };
}
function cleanComment(data) {
  const nickname = text(data.nickname, 1, 20), body = text(data.body, 2, 2000);
  if (!nickname) return { error: '별명을 1~20자로 적어주세요.' };
  if (!body) return { error: '댓글을 2~2000자로 적어주세요.' };
  if (!EXPERIENCES.includes(data.experience)) return { error: '경험 여부를 선택해 주세요.' };
  return { value: { nickname, body, experience: data.experience } };
}

// 밖으로 내보낼 때는 작성자 번호(author)를 빼고 "내 글인지"만 알려줍니다.
const publicPost = (p, author) => ({
  id: p.id, kind: p.kind, sport: p.sport, title: p.title, body: p.body, nickname: p.nickname,
  experience: p.experience, created_at: p.created_at, updated_at: p.updated_at, isMine: p.author === author,
});
const publicComment = (c, author) => ({
  id: c.id, post_id: c.post_id, nickname: c.nickname, experience: c.experience, body: c.body,
  created_at: c.created_at, isMine: c.author === author,
});

async function allPosts(store) {
  const { blobs } = await store.list({ prefix: 'posts/' });
  const posts = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return posts.filter(Boolean);
}

async function tooFast(store, author) {
  const key = 'last/' + author, last = await store.get(key, { type: 'json' }), now = Date.now();
  if (last && now - last.t < WRITE_GAP_MS) return true;
  await store.setJSON(key, { t: now });
  return false;
}

export default async (req) => {
  try {
    const store = getStore({ name: 'community', consistency: 'strong' });
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/community/, '') || '/';
    const parts = path.split('/').filter(Boolean); // 예: ['posts', '<id>', 'comments']
    const method = req.method.toUpperCase();

    let author = readAuthor(req);
    const headers = {};
    if (!author) { author = crypto.randomUUID(); headers['set-cookie'] = authorCookie(author); }
    const ok = (data, status = 200) => json(data, status, headers);

    // 운영자 삭제용: Netlify 환경변수 ADMIN_KEY 를 정해 두고 주소 끝에 ?admin=값 을 붙이면 남의 글도 지울 수 있습니다.
    const adminKey = process.env.ADMIN_KEY;
    const isAdmin = Boolean(adminKey) && url.searchParams.get('admin') === adminKey;

    let data = {};
    if (method === 'POST' || method === 'PATCH') {
      try { data = await req.json(); } catch { return fail('요청 형식이 올바르지 않아요.'); }
      if (!data || typeof data !== 'object') return fail('요청 형식이 올바르지 않아요.');
    }

    if (path === '/me' && method === 'GET') return ok({ signedIn: true });

    // 글 목록
    if (path === '/posts' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim(), kind = url.searchParams.get('kind') || '',
        sport = url.searchParams.get('sport') || '', page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const posts = (await allPosts(store))
        .filter((p) => (!q || (p.title + p.body).includes(q)) && (!kind || p.kind === kind) && (!sport || p.sport === sport))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return ok({
        posts: posts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
          .map((p) => ({ ...publicPost(p, author), comments: (p.comments || []).length })),
        total: posts.length, page,
      });
    }

    // 글 쓰기
    if (path === '/posts' && method === 'POST') {
      const c = cleanPost(data); if (c.error) return fail(c.error);
      const { blobs } = await store.list({ prefix: 'posts/' });
      if (blobs.length >= MAX_POSTS) return fail('게시판이 가득 찼어요. 운영자에게 알려주세요.', 507);
      if (await tooFast(store, author)) return fail('잠시 후 다시 시도해 주세요.', 429);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await store.setJSON('posts/' + id, { ...c.value, id, author, created_at: now, updated_at: now, comments: [] });
      return ok({ id }, 201);
    }

    // 댓글 삭제
    if (parts[0] === 'comments' && parts.length === 2 && method === 'DELETE') {
      const ref = await store.get('comments/' + parts[1], { type: 'json' });
      const post = ref && await store.get('posts/' + ref.post_id, { type: 'json' });
      if (!post) return ok({ ok: true });
      const target = (post.comments || []).find((x) => x.id === parts[1]);
      if (target && target.author !== author && !isAdmin) return fail('본인이 작성한 댓글만 삭제할 수 있어요.', 403);
      post.comments = (post.comments || []).filter((x) => x.id !== parts[1]);
      await store.setJSON('posts/' + post.id, post);
      await store.delete('comments/' + parts[1]);
      return ok({ ok: true });
    }

    if (parts[0] !== 'posts' || parts.length < 2 || !/^[A-Za-z0-9-]{8,64}$/.test(parts[1])) return fail('지원하지 않는 요청입니다.', 404);
    const id = parts[1], key = 'posts/' + id;
    const post = await store.get(key, { type: 'json' });
    if (!post) return fail('글을 찾지 못했어요.', 404);
    post.comments = post.comments || [];

    // 댓글 쓰기
    if (parts[2] === 'comments' && parts.length === 3 && method === 'POST') {
      const c = cleanComment(data); if (c.error) return fail(c.error);
      if (post.comments.length >= MAX_COMMENTS) return fail('이 글에는 더 이상 댓글을 달 수 없어요.', 507);
      if (await tooFast(store, author)) return fail('잠시 후 다시 시도해 주세요.', 429);
      const cid = crypto.randomUUID();
      post.comments.push({ ...c.value, id: cid, post_id: id, author, created_at: new Date().toISOString() });
      await store.setJSON(key, post);
      await store.setJSON('comments/' + cid, { post_id: id });
      return ok({ id: cid }, 201);
    }
    if (parts.length !== 2) return fail('지원하지 않는 요청입니다.', 404);

    // 글 하나 보기
    if (method === 'GET') return ok({ post: publicPost(post, author), comments: post.comments.map((c) => publicComment(c, author)) });

    if (post.author !== author && !(isAdmin && method === 'DELETE')) return fail('본인이 작성한 글만 수정·삭제할 수 있어요.', 403);

    // 글 수정
    if (method === 'PATCH') {
      const c = cleanPost({ ...post, ...data }); if (c.error) return fail(c.error);
      await store.setJSON(key, { ...post, ...c.value, updated_at: new Date().toISOString() });
      return ok({ ok: true });
    }
    // 글 삭제 (댓글도 함께)
    if (method === 'DELETE') {
      await Promise.all(post.comments.map((c) => store.delete('comments/' + c.id)));
      await store.delete(key);
      return ok({ ok: true });
    }
    return fail('지원하지 않는 요청입니다.', 405);
  } catch (error) {
    console.error(error);
    return fail('서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.', 500);
  }
};
