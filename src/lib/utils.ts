import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function getCountdownValue(expiresAt: string) {
	const expires = new Date(expiresAt + 'Z').getTime();
	const now = Date.now();
	const diff = expires - now;

	if (diff <= 0) return 'Expired';

	const h = Math.floor(diff / (1000 * 60 * 60));
	const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export interface Post {
	id: string;
	content: string;
	author_name: string;
	colorHex: string;
	up_count: number;
	down_count: number;
	created_at: string;
	expires_at: string;
	reply_to: string | null;
	isHidden?: boolean;
}
