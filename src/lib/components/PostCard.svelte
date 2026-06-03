<script lang="ts">
	import type { Post } from '$lib/utils';
	import { cn, getCountdownValue } from '$lib/utils';
	import { ArrowUp, ArrowDown, MessageCircle, Share, Clock } from 'lucide-svelte';
	import { toBlob } from 'html-to-image';

	let { post, isDark, replyCount, onInteract, onReply } = $props<{
		post: Post;
		isDark: boolean;
		replyCount: number;
		onInteract: (id: string, action: 'up' | 'down') => void;
		onReply: (post: Post) => void;
	}>();

	let timeLeft = $state(getCountdownValue(post.expires_at));
	let isSharing = $state(false);
	let exportContainerRef = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const timer = setInterval(() => {
			timeLeft = getCountdownValue(post.expires_at);
		}, 60000);
		return () => clearInterval(timer);
	});

	const score = $derived(post.up_count - post.down_count);

	const handleShare = async () => {
		isSharing = true;
		try {
			await new Promise((r) => setTimeout(r, 100)); // wait for flush

			if (!exportContainerRef) return;

			const blob = await toBlob(exportContainerRef, {
				backgroundColor: isDark ? '#0a0a0a' : '#ffffff',
				pixelRatio: 2
			});

			if (!blob) return;

			const file = new File([blob], `whisp-${post.id}.png`, {
				type: 'image/png'
			});

			if (navigator.canShare && navigator.canShare({ files: [file] })) {
				try {
					await navigator.share({
						files: [file],
						title: 'A whisper from whisp'
					});
				} catch (err) {
					console.log('Share failed, falling back to download', err);
					downloadBlob(blob, `whisp-${post.id}.png`);
				}
			} else {
				downloadBlob(blob, `whisp-${post.id}.png`);
			}
		} catch (err) {
			console.error('Failed to share', err);
		} finally {
			isSharing = false;
		}
	};

	const downloadBlob = (blob: Blob, filename: string) => {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};
</script>

{#if !post.isHidden}
	<div class="border border-gray-200 dark:border-gray-800 rounded-xl p-4 mb-4 shadow-sm bg-white dark:bg-[#0a0a0a] flex flex-col gap-3 relative">
		<div class="flex justify-between items-start">
			<div class="flex items-center gap-3">
				<div class="w-8 h-8 rounded-full flex-shrink-0" style="background-color: {post.colorHex}"></div>
				<div class="font-semibold text-sm text-black dark:text-white">
					<bdi>{post.author_name}</bdi>
				</div>
			</div>
			<div class="text-xs text-gray-500 font-mono flex items-center gap-1">
				Disappears in {timeLeft}
			</div>
		</div>

		<p class="text-sm/relaxed whitespace-pre-wrap mt-1 break-words text-black dark:text-white">
			{post.content}
		</p>

		<div class="flex items-center gap-4 mt-2 pt-2 text-gray-500 dark:text-gray-400">
			<div class="flex items-center gap-1">
				<button onclick={() => onInteract(post.id, 'up')} class="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded hover:text-black dark:hover:text-white transition-colors cursor-pointer">
					<ArrowUp class="w-4 h-4" />
				</button>
				<span class="text-xs font-mono w-6 text-center tabular-nums">{score}</span>
				<button onclick={() => onInteract(post.id, 'down')} class="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded hover:text-black dark:hover:text-white transition-colors cursor-pointer">
					<ArrowDown class="w-4 h-4" />
				</button>
			</div>
			<button onclick={() => onReply(post)} class="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded hover:text-black dark:hover:text-white transition-colors cursor-pointer flex items-center gap-1">
				<MessageCircle class="w-4 h-4" />
				<span class="text-xs font-mono">{replyCount > 0 ? replyCount : ''}</span>
			</button>

			<button onclick={handleShare} disabled={isSharing} class="ml-auto p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded hover:text-black dark:hover:text-white transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-50">
				<Share class="w-4 h-4" />
			</button>
		</div>

		<!-- Hidden export layout strictly for HTML2Canvas -->
		<div class="fixed top-[-9999px] left-[-9999px] -z-50 pointer-events-none">
			{#if isSharing}
				<div bind:this={exportContainerRef}>
					<!-- ShareCanvas logic inline to keep it simple -->
					<div class={cn('w-[400px] p-6 rounded-3xl flex flex-col gap-4 font-sans border-2 items-start justify-center', isDark ? 'bg-[#0a0a0a] text-white border-white/10' : 'bg-white text-black border-black/10')} style="isolation: isolate">
						<div class="flex w-full justify-between items-start">
							<div class="flex items-center gap-3">
								<div class="w-10 h-10 rounded-full flex-shrink-0" style="background-color: {post.colorHex}"></div>
								<div class="font-semibold text-base"><bdi>{post.author_name}</bdi></div>
							</div>
							<div class="text-xs font-mono opacity-60 flex items-center gap-1 mt-1">
								<Clock class="w-3 h-3" />
								{timeLeft}
							</div>
						</div>
						<p class="text-xl leading-relaxed whitespace-pre-wrap break-words font-medium mt-2 w-full">{post.content}</p>

						<div class="flex items-center gap-4 mt-2 font-mono text-sm opacity-60 w-full">
							<div class="flex items-center gap-1">
								<ArrowUp class="w-4 h-4" />
								<span>{post.up_count}</span>
							</div>
							<div class="flex items-center gap-1">
								<ArrowDown class="w-4 h-4" />
								<span>{post.down_count}</span>
							</div>
							<div class="flex items-center gap-1">
								<MessageCircle class="w-4 h-4" />
								<span>{replyCount}</span>
							</div>
						</div>

						<div class={cn('mt-6 text-sm font-mono opacity-40 flex flex-col gap-1 w-full text-center border-t pt-4', isDark ? 'border-white/10' : 'border-black/10')}>
							<span>whispered on whisp.</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div class="hidden"></div>
{/if}
