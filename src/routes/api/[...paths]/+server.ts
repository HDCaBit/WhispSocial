import { Hono } from 'hono';
import { nanoid } from 'nanoid';

type Bindings = {
	DB: D1Database;
	KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>().basePath('/api');

const SECRET_SALT = 'whisp-cloudflare-salt'; // In production, use env vars

const EMOJIS = ['👻', '👽', '🤖', '🤠', '👾', '🤡', '👹', '👺', '🦉', '🦇'];
const ADJECTIVES = [
	'Silent', 'Swift', 'Brave', 'Calm', 'Fierce',
	'Скрытный', 'Быстрый', 'Храбрый',
	'沉默', '敏捷', '勇敢',
	'조용한', '빠른', '용감한',
	'صامت', 'سريع', 'شجاع'
];
const NOUNS = [
	'Shadow', 'Echo', 'Whisper', 'Phantom', 'Spirit',
	'Тень', 'Эхо', 'Шепот',
	'阴影', '回声', '耳语',
	'그림자', '메아리', '속삭임',
	'ظل', 'صدى', 'همس'
];

async function generateBabelIdentity(ip: string) {
	const dateString = new Date().toISOString().split('T')[0];
	const msgBuffer = new TextEncoder().encode(ip + SECRET_SALT + dateString);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

	const token = hashHex;
	
	const emojiIndex = parseInt(hashHex.slice(0, 2), 16) % EMOJIS.length;
	const adjIndex = parseInt(hashHex.slice(2, 4), 16) % ADJECTIVES.length;
	const nounIndex = parseInt(hashHex.slice(4, 6), 16) % NOUNS.length;
	const colorHex = '#' + hashHex.slice(6, 12);

	const authorName = `${EMOJIS[emojiIndex]} ${ADJECTIVES[adjIndex]} ${NOUNS[nounIndex]}`;

	return { authorToken: token, authorName, colorHex };
}

// Get Client IP in Cloudflare Workers
function getClientIp(req: Request) {
	return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown-ip';
}

app.get('/identity', async (c) => {
	const ip = getClientIp(c.req.raw);
	const identity = await generateBabelIdentity(ip);
	return c.json({
		name: identity.authorName,
		color: identity.colorHex,
		tokenHash: identity.authorToken.slice(0, 8)
	});
});

app.post('/posts', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const { content, reply_to, cf_turnstile_response } = body;
	
	if (!content || typeof content !== 'string' || content.length > 500 || content.trim().length === 0) {
		return c.json({ error: 'Invalid post content (max 500 chars)' }, 400);
	}

	if (!cf_turnstile_response) {
		return c.json({ error: 'Captcha validation missing' }, 400);
	}

	// 1. Verify Cloudflare Turnstile
	// Note: Using the always-passes test secret key. User should swap with real secret in production.
	const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
	const turnstileFormData = new FormData();
	turnstileFormData.append('secret', TURNSTILE_SECRET);
	turnstileFormData.append('response', cf_turnstile_response);

	try {
		const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body: turnstileFormData
		});
		const outcome = await result.json();
		if (!outcome.success) {
			return c.json({ error: 'Captcha verification failed' }, 403);
		}
	} catch (e) {
		return c.json({ error: 'Captcha service unavailable' }, 500);
	}

	const ip = getClientIp(c.req.raw);

	// 2. Check Cooldown (1 post per 2.5 hours per IP)
	const cooldownKey = `post_cooldown:${ip}`;
	const hasCooldown = await c.env.KV.get(cooldownKey);
	if (hasCooldown) {
		return c.json({ error: 'Chill out! You can only whisper once every 2.5 hours.' }, 429);
	}

	// 3. Check Daily Limit (10 posts per day per IP)
	const dailyKey = `post_daily:${ip}`;
	const dailyCountStr = await c.env.KV.get(dailyKey);
	const dailyCount = dailyCountStr ? parseInt(dailyCountStr, 10) : 0;
	if (dailyCount >= 10) {
		return c.json({ error: 'Daily limit reached. You can only whisper 10 times a day.' }, 429);
	}

	const { authorName, authorToken } = await generateBabelIdentity(ip);
	const id = nanoid(8);

	try {
		await c.env.DB.prepare(`
			INSERT INTO posts (id, content, author_name, author_token, expires_at, reply_to)
			VALUES (?, ?, ?, ?, datetime('now', '+1 day'), ?)
		`).bind(id, content, authorName, authorToken, reply_to || null).run();

		// Record Rate Limits in KV
		await c.env.KV.put(cooldownKey, '1', { expirationTtl: 9000 }); // 2.5 hours = 9000 seconds
		await c.env.KV.put(dailyKey, (dailyCount + 1).toString(), { expirationTtl: 86400 }); // 24 hours

		return c.json({ success: true, id }, 201);
	} catch (err) {
		return c.json({ error: 'Database error' }, 500);
	}
});

app.get('/posts', async (c) => {
	try {
		// Lazy cleanup: Hapus post kadaluarsa secara otomatis saat feed dimuat
		c.env.DB.prepare("DELETE FROM posts WHERE expires_at <= datetime('now')").run().catch(console.error);

		// Calculate Gravity Score in SQL and sort, then return
		// Score = (UP - DOWN) / (Age in Hours + 2)^1.8
		// Age in hours: (julianday('now') - julianday(created_at)) * 24
		const query = `
			SELECT *, 
			(up_count - down_count) / POW(MAX(0, (julianday('now') - julianday(created_at)) * 24) + 2, 1.8) as gravity_score
			FROM posts 
			WHERE expires_at > datetime('now')
			ORDER BY gravity_score DESC
		`;
		
		const { results } = await c.env.DB.prepare(query).all();

		const clientPosts = results.map((p: any) => {
			const derivedColor = '#' + p.author_token.slice(6, 12);
			const isHidden = (p.up_count - p.down_count) <= -5;
			return {
				id: p.id,
				content: p.content,
				author_name: p.author_name,
				colorHex: derivedColor,
				up_count: p.up_count,
				down_count: p.down_count,
				created_at: p.created_at,
				expires_at: p.expires_at,
				reply_to: p.reply_to,
				isHidden
			};
		});

		return c.json(clientPosts);
	} catch (err) {
		console.error(err);
		return c.json({ error: 'Database error' }, 500);
	}
});

app.post('/posts/:id/interact', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json().catch(() => ({}));
	const { action } = body;

	if (action !== 'up' && action !== 'down') {
		return c.json({ error: 'Invalid action' }, 400);
	}

	const ip = getClientIp(c.req.raw);
	const { authorToken } = await generateBabelIdentity(ip);

	const kvKey = `interact:${id}:${authorToken}`;
	
	// Check rate limit in KV
	const hasInteracted = await c.env.KV.get(kvKey);
	if (hasInteracted) {
		return c.json({ error: 'Already interacted with this post today' }, 403);
	}

	try {
		// Check if post exists
		const post = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first();
		if (!post) {
			return c.json({ error: 'Post not found' }, 404);
		}

		const upInc = action === 'up' ? 1 : 0;
		const downInc = action === 'down' ? 1 : 0;

		await c.env.DB.prepare(`
			UPDATE posts
			SET up_count = up_count + ?, down_count = down_count + ?
			WHERE id = ?
		`).bind(upInc, downInc, id).run();

		// Record interaction with 24 hours expiration
		await c.env.KV.put(kvKey, '1', { expirationTtl: 86400 });

		return c.json({ success: true });
	} catch (err) {
		return c.json({ error: 'Database error' }, 500);
	}
});

export const GET = (event: any) => app.fetch(event.request, event.platform?.env);
export const POST = (event: any) => app.fetch(event.request, event.platform?.env);
export const PUT = (event: any) => app.fetch(event.request, event.platform?.env);
export const DELETE = (event: any) => app.fetch(event.request, event.platform?.env);
export const PATCH = (event: any) => app.fetch(event.request, event.platform?.env);
export const OPTIONS = (event: any) => app.fetch(event.request, event.platform?.env);
