import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { nanoid } from 'nanoid';

type Bindings = {
	DB: D1Database;
	KV: KVNamespace;
	TURNSTILE_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>().basePath('/api');

app.onError((err, c) => {
	console.error('Hono Error:', err);
	return c.json({ error: err.message, stack: err.stack }, 500);
});

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

async function generateBabelIdentity(uniqueId: string) {
	// Identity rotates daily at 00:00 UTC
	const dateString = new Date().toISOString().split('T')[0];
	const msgBuffer = new TextEncoder().encode(uniqueId + SECRET_SALT + dateString);
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

function getClientIp(req: Request) {
	return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown-ip';
}

function getOrCreateDeviceId(c: any) {
	let deviceId = getCookie(c, 'whisp_device_id');
	if (!deviceId) {
		deviceId = nanoid(32);
		setCookie(c, 'whisp_device_id', deviceId, {
			path: '/',
			secure: true,
			httpOnly: true,
			sameSite: 'Strict',
			maxAge: 60 * 60 * 24 * 365 // 1 year (Must be <= 400 days)
		});
	}
	return deviceId;
}

app.get('/me', async (c) => {
	const deviceId = getOrCreateDeviceId(c);
	const identity = await generateBabelIdentity(deviceId);

	const cooldownKeyDevice = `post_cooldown:${deviceId}`;
	const cooldownExpireStr = await c.env.KV.get(cooldownKeyDevice);
	const cooldownExpiresAt = cooldownExpireStr ? parseInt(cooldownExpireStr, 10) : null;

	const dailyKeyDevice = `post_daily:${deviceId}`;
	const dailyCountStr = await c.env.KV.get(dailyKeyDevice);
	const dailyCount = dailyCountStr ? parseInt(dailyCountStr, 10) : 0;

	return c.json({
		name: identity.authorName,
		color: identity.colorHex,
		dailyCount,
		cooldownExpiresAt
	});
});

app.get('/posts/check-limit', async (c) => {
	const ip = getClientIp(c.req.raw);
	const deviceId = getOrCreateDeviceId(c);

	const cooldownKeyIP = `post_cooldown:${ip}`;
	const cooldownKeyDevice = `post_cooldown:${deviceId}`;
	
	const hasCooldownIP = await c.env.KV.get(cooldownKeyIP);
	const hasCooldownDevice = await c.env.KV.get(cooldownKeyDevice);
	
	if (hasCooldownIP || hasCooldownDevice) {
		return c.json({ allowed: false, reason: 'Chill out! You can only whisper once every 2.5 hours.' });
	}

	const dailyKeyIP = `post_daily:${ip}`;
	const dailyKeyDevice = `post_daily:${deviceId}`;
	const countIP = parseInt(await c.env.KV.get(dailyKeyIP) || '0', 10);
	const countDevice = parseInt(await c.env.KV.get(dailyKeyDevice) || '0', 10);
	
	if (countIP >= 10 || countDevice >= 10) {
		return c.json({ allowed: false, reason: 'Daily limit reached. You can only whisper 10 times a day.' });
	}

	return c.json({ allowed: true });
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
	const TURNSTILE_SECRET = c.env.TURNSTILE_SECRET || '1x0000000000000000000000000000000AA';
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
	const deviceId = getOrCreateDeviceId(c);

	// 2. Check Cooldown (Double Check)
	const cooldownKeyIP = `post_cooldown:${ip}`;
	const cooldownKeyDevice = `post_cooldown:${deviceId}`;
	if ((await c.env.KV.get(cooldownKeyIP)) || (await c.env.KV.get(cooldownKeyDevice))) {
		return c.json({ error: 'Chill out! You can only whisper once every 2.5 hours.' }, 429);
	}

	// 3. Check Daily Limit (Double Check)
	const dailyKeyIP = `post_daily:${ip}`;
	const dailyKeyDevice = `post_daily:${deviceId}`;
	const countIP = parseInt(await c.env.KV.get(dailyKeyIP) || '0', 10);
	const countDevice = parseInt(await c.env.KV.get(dailyKeyDevice) || '0', 10);
	
	if (countIP >= 10 || countDevice >= 10) {
		return c.json({ error: 'Daily limit reached. You can only whisper 10 times a day.' }, 429);
	}

	const { authorName, authorToken } = await generateBabelIdentity(deviceId);
	const id = nanoid(8);

	try {
		await c.env.DB.prepare(`
			INSERT INTO posts (id, content, author_name, author_token, expires_at, reply_to)
			VALUES (?, ?, ?, ?, datetime('now', '+1 day'), ?)
		`).bind(id, content, authorName, authorToken, reply_to || null).run();

		// Record Rate Limits in KV (2.5 hours = 9000 seconds)
		const expireTimeMs = Date.now() + (9000 * 1000); 
		await c.env.KV.put(cooldownKeyDevice, expireTimeMs.toString(), { expirationTtl: 9000 });
		await c.env.KV.put(cooldownKeyIP, expireTimeMs.toString(), { expirationTtl: 9000 });
		
		const newDailyCount = Math.max(countIP, countDevice) + 1;
		await c.env.KV.put(dailyKeyDevice, newDailyCount.toString(), { expirationTtl: 86400 });
		await c.env.KV.put(dailyKeyIP, newDailyCount.toString(), { expirationTtl: 86400 });

		return c.json({ success: true, id }, 201);
	} catch (err) {
		return c.json({ error: 'Database error' }, 500);
	}
});

app.get('/posts', async (c) => {
	try {
		c.env.DB.prepare("DELETE FROM posts WHERE expires_at <= datetime('now')").run().catch(console.error);

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
	const deviceId = getOrCreateDeviceId(c);

	const kvKeyIP = `interact:${id}:${ip}`;
	const kvKeyDevice = `interact:${id}:${deviceId}`;
	
	if ((await c.env.KV.get(kvKeyIP)) || (await c.env.KV.get(kvKeyDevice))) {
		return c.json({ error: 'Already interacted with this post today' }, 403);
	}

	try {
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
		await c.env.KV.put(kvKeyDevice, '1', { expirationTtl: 86400 });
		await c.env.KV.put(kvKeyIP, '1', { expirationTtl: 86400 });

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
