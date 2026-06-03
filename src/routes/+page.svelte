<script lang="ts">
	import { onMount } from 'svelte';
	import { Sun, Moon, Plus, Send, X, AlertCircle, CheckCircle2, Loader2 } from 'lucide-svelte';
	import PostCard from '$lib/components/PostCard.svelte';
	import type { Post } from '$lib/utils';
	import { cn } from '$lib/utils';

	let posts = $state<Post[]>([]);
	let content = $state('');
	let isDarkMode = $state(false);
	let isSubmitting = $state(false);
	let isPendingSubmit = $state(false);
	let replyingTo = $state<Post | null>(null);
	let isComposing = $state(false);
	let inputRef = $state<HTMLTextAreaElement | null>(null);

	// Captcha Modal State
	let isShowCaptchaModal = $state(false);
	let captchaContainer = $state<HTMLDivElement | null>(null);
	let turnstileWidgetId = $state<string | null>(null);

	// Modal State
	let modal = $state({ show: false, message: '', isError: true });
	const showModal = (message: string, isError = true) => {
		modal = { show: true, message, isError };
		setTimeout(() => { modal.show = false; }, 4000);
	};

	$effect(() => {
		if (typeof document !== 'undefined') {
			if (isDarkMode) {
				document.documentElement.classList.add('dark');
			} else {
				document.documentElement.classList.remove('dark');
			}
		}
	});

	// Render Turnstile explicitly when the modal appears
	$effect(() => {
		if (isShowCaptchaModal && captchaContainer && typeof (window as any).turnstile !== 'undefined' && !turnstileWidgetId) {
			turnstileWidgetId = (window as any).turnstile.render(captchaContainer, {
				sitekey: '0x4AAAAAADeLbquOg0U-I8Cd', // Site Key asli User
				callback: (token: string) => {
					if (isPendingSubmit) {
						isShowCaptchaModal = false; // Sembunyikan popup captcha saat sukses
						executePost(token);
					}
				},
				'error-callback': () => {
					showModal('Captcha verification failed. Please try again.', true);
					isShowCaptchaModal = false;
					isSubmitting = false;
					isPendingSubmit = false;
				},
				theme: isDarkMode ? 'dark' : 'light'
			});
		}

		// Cleanup widget jika modal ditutup (misalnya dibatalkan)
		if (!isShowCaptchaModal && turnstileWidgetId && typeof (window as any).turnstile !== 'undefined') {
			(window as any).turnstile.remove(turnstileWidgetId);
			turnstileWidgetId = null;
		}
	});

	const fetchPosts = async () => {
		try {
			const res = await fetch('/api/posts');
			const data = await res.json();
			if (res.ok) posts = data;
		} catch (err) {
			console.error('Failed to fetch posts', err);
		}
	};

	const executePost = async (token: string) => {
		try {
			const res = await fetch('/api/posts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content,
					reply_to: replyingTo?.id || null,
					cf_turnstile_response: token
				})
			});
			
			const data = await res.json();
			
			if (res.ok) {
				content = '';
				replyingTo = null;
				isComposing = false;
				fetchPosts();
				showModal('Whisper sent successfully!', false);
			} else {
				showModal(data.error || 'Failed to send whisper', true);
			}
		} catch (err) {
			console.error(err);
			showModal('Network error occurred.', true);
		} finally {
			isSubmitting = false;
			isPendingSubmit = false;
		}
	};

	onMount(() => {
		if (typeof window !== 'undefined') {
			if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
				isDarkMode = true;
			}
		}
		fetchPosts();
		const interval = setInterval(fetchPosts, 30000);
		return () => clearInterval(interval);
	});

	$effect(() => {
		if (isComposing && inputRef) {
			inputRef.focus();
		}
	});

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!content.trim() || content.length > 500) return;
		
		isSubmitting = true;
		
		try {
			// 1. Cek Cooldown & Limit Kuota di Server terlebih dahulu
			const limitRes = await fetch('/api/posts/check-limit');
			const limitData = await limitRes.json();
			
			if (!limitData.allowed) {
				showModal(limitData.reason, true);
				isSubmitting = false;
				return;
			}

			// 2. Jika lolos limit, buka Modal Captcha
			isPendingSubmit = true;
			isShowCaptchaModal = true;
		} catch (err) {
			console.error(err);
			showModal('Network error occurred.', true);
			isSubmitting = false;
		}
	};

	const handleInteract = async (id: string, action: 'up' | 'down') => {
		try {
			const res = await fetch(`/api/posts/${id}/interact`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			
			if (res.ok) {
				posts = posts.map((p) => {
					if (p.id === id) {
						return {
							...p,
							up_count: action === 'up' ? p.up_count + 1 : p.up_count,
							down_count: action === 'down' ? p.down_count + 1 : p.down_count
						};
					}
					return p;
				});
			} else {
				const err = await res.json();
				showModal(err.error || 'Cannot interact again today', true);
			}
		} catch (err) {
			console.error(err);
			showModal('Network error occurred.', true);
		}
	};

	const handleReplyInit = (post: Post) => {
		replyingTo = post;
		isComposing = true;
	};

	const parents = $derived(posts.filter((p) => !p.reply_to));
	const replies = $derived(posts.filter((p) => p.reply_to));
</script>

<svelte:head>
	<!-- Use render=explicit so we can manually control when to show it -->
	<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
</svelte:head>

<!-- Global Message Modal Popup -->
{#if modal.show}
	<div class="fixed top-20 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-4 duration-300">
		<div class={cn(
			"flex items-center gap-2 px-4 py-3 rounded-full shadow-lg border backdrop-blur-md text-sm font-medium",
			modal.isError 
				? "bg-red-50/90 border-red-200 text-red-600 dark:bg-red-950/90 dark:border-red-900 dark:text-red-300" 
				: "bg-emerald-50/90 border-emerald-200 text-emerald-600 dark:bg-emerald-950/90 dark:border-emerald-900 dark:text-emerald-300"
		)}>
			{#if modal.isError}
				<AlertCircle class="w-4 h-4" />
			{:else}
				<CheckCircle2 class="w-4 h-4" />
			{/if}
			{modal.message}
		</div>
	</div>
{/if}

<!-- Center Captcha Modal Overlay -->
{#if isShowCaptchaModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
		<div class="bg-white dark:bg-[#111] border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-4 animate-in zoom-in-95 duration-200">
			<div class="flex items-center justify-between w-full">
				<h3 class="text-sm font-semibold">Security Check</h3>
				<button 
					onclick={() => { 
						isShowCaptchaModal = false; 
						isSubmitting = false; 
						isPendingSubmit = false; 
					}} 
					class="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
			
			<div class="min-h-[65px] min-w-[300px] flex items-center justify-center bg-gray-50 dark:bg-black rounded-lg border border-dashed border-gray-200 dark:border-gray-800">
				<!-- Turnstile Widget akan di-render di dalam div ini -->
				<div bind:this={captchaContainer}></div>
			</div>
			
			<p class="text-xs text-gray-400 text-center px-4">
				Please verify you are human before whispering to the void.
			</p>
		</div>
	</div>
{/if}

<div class="min-h-screen bg-white dark:bg-[#0a0a0a] text-black dark:text-white font-sans selection:bg-black selection:text-white dark:selection:bg-white dark:selection:text-black">
	<!-- Sticky Header -->
	<header class="sticky top-0 z-10 backdrop-blur-md bg-white/80 dark:bg-black/80 border-b border-gray-100 dark:border-gray-900 px-4 py-3">
		<div class="max-w-xl mx-auto w-full flex items-center justify-between">
			<h1 class="text-xl font-bold font-mono tracking-tight lowercase flex items-center gap-2">
				whisp
			</h1>
			<div class="flex items-center gap-4">
				<button onclick={() => (isDarkMode = !isDarkMode)} class="text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white transition-colors cursor-pointer" aria-label="Toggle Theme">
					{#if isDarkMode}
						<Sun class="w-5 h-5" />
					{:else}
						<Moon class="w-5 h-5" />
					{/if}
				</button>
				<button
					onclick={() => {
						replyingTo = null;
						isComposing = true;
						window.scrollTo({ top: 0, behavior: 'smooth' });
					}}
					class="bg-black text-white dark:bg-white text-black p-1.5 rounded-full hover:opacity-80 transition-opacity cursor-pointer flex items-center justify-center"
					aria-label="New Post"
				>
					<Plus class="w-5 h-5" />
				</button>
			</div>
		</div>
	</header>

	<div class="max-w-xl mx-auto w-full px-4 sm:px-0 py-6 flex flex-col gap-6 relative">
		<!-- Feed -->
		<main class="flex flex-col pb-36">
			{#if parents.length === 0}
				<div class="text-center py-20 text-gray-400 font-mono text-sm">
					The void is currently empty.
				</div>
			{:else}
				{#each parents as post (post.id)}
					<div class="relative">
						<PostCard {post} {isDarkMode} replyCount={replies.filter((r) => r.reply_to === post.id).length} onInteract={handleInteract} onReply={handleReplyInit} />

						{#if replies.filter((r) => r.reply_to === post.id).length > 0}
							<div class="pl-6 md:pl-10 relative flex flex-col gap-0 border-l-2 border-gray-100 dark:border-gray-900 ml-4 mb-4 mt-[-10px]">
								{#each replies.filter((r) => r.reply_to === post.id) as reply (reply.id)}
									<div class="mt-4">
										<PostCard post={reply} {isDarkMode} replyCount={0} onInteract={handleInteract} onReply={() => handleReplyInit(post)} />
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</main>
	</div>

	<!-- Fixed Bottom Compose Area -->
	{#if isComposing}
		<div class="fixed bottom-0 left-0 w-full z-20 px-4 pb-6 pt-4 bg-white/95 dark:bg-[#0a0a0a]/95 backdrop-blur-md border-t border-gray-200 dark:border-gray-800 animate-in slide-in-from-bottom-5">
			<div class="max-w-xl mx-auto">
				{#if replyingTo}
					<div class="mb-3 p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg flex items-start justify-between shadow-sm">
						<div class="flex flex-col gap-1 overflow-hidden">
							<span class="text-xs font-semibold text-gray-500">
								Replying to <bdi>{replyingTo.author_name}</bdi>
							</span>
							<p class="text-sm truncate opacity-80">
								{replyingTo.content}
							</p>
						</div>
						<button onclick={() => (replyingTo = null)} class="text-gray-400 hover:text-black dark:hover:text-white p-1 cursor-pointer flex-shrink-0">
							<X class="w-4 h-4" />
						</button>
					</div>
				{/if}
				<form onsubmit={handleSubmit} class="flex flex-col gap-3">
					<div class="flex items-end gap-2 bg-white dark:bg-[#111] border border-gray-300 dark:border-gray-700 rounded-2xl p-2 shadow-sm focus-within:ring-2 focus-within:ring-black dark:focus-within:ring-white focus-within:border-transparent transition-all">
						<textarea
							bind:this={inputRef}
							bind:value={content}
							class="w-full bg-transparent resize-none border-none p-2 max-h-[150px] min-h-[44px] text-base placeholder-gray-400 dark:placeholder-gray-600 outline-none flex-1 py-2.5"
							placeholder={replyingTo ? 'Write your reply...' : 'Whisper something to the void...'}
							maxlength="500"
							onkeydown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									if (content.trim()) handleSubmit(e);
								}
							}}
						></textarea>

						<button type="submit" disabled={!content.trim() || isSubmitting} class="flex-shrink-0 p-3 bg-black dark:bg-white text-white dark:text-black rounded-xl hover:opacity-80 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer mb-0.5" aria-label="Send whisper">
							{#if isSubmitting && !isShowCaptchaModal}
								<Loader2 class="w-4 h-4 animate-spin" />
							{:else}
								<Send class="w-4 h-4" />
							{/if}
						</button>
					</div>

					<div class="flex items-center justify-end px-2">
						<div class="flex items-center gap-3">
							<span class={cn('text-xs font-mono', content.length > 450 ? 'text-red-500' : 'text-gray-400')}>
								{content.length} / 500
							</span>
							<button
								type="button"
								onclick={() => {
									isComposing = false;
									replyingTo = null;
									content = '';
								}}
								class="text-xs font-mono text-gray-500 hover:text-black dark:hover:text-white transition-colors cursor-pointer"
							>
								Cancel
							</button>
						</div>
					</div>
				</form>
			</div>
		</div>
	{/if}
</div>
