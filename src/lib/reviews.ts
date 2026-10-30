import type { ImageMetadata, MarkdownInstance } from 'astro';

/**
 * Reviews live in src/reviews/<url>/ (the folder name becomes /reviews/<url>):
 *
 *   src/reviews/<url>/
 *     review.md        the review text (any single .md file works)
 *     date.txt         the date posted, as YYYY-MM-DD
 *     thumbnail/       exactly one image (png, jpg, webp, avif, gif or svg)
 *                      or video (mp4, webm, mov, m4v or ogv)
 *     pictures/        optional extra images/videos, shown under the thumbnail on the
 *                      review page (not in the grid), sorted by file name
 *
 * The review title is the first "# Heading" in the markdown file.
 * If there isn't one, the folder name is used instead.
 */
const REVIEWS_DIR = 'src/reviews';

const markdownFiles = import.meta.glob<MarkdownInstance<Record<string, unknown>>>('/src/reviews/*/*.md', {
	eager: true,
});
const dateFiles = import.meta.glob<string>('/src/reviews/*/date.txt', {
	eager: true,
	query: '?raw',
	import: 'default',
});
// Glob patterns must be plain string literals for Vite, so the extension lists are repeated.
const thumbnailImages = import.meta.glob<ImageMetadata>('/src/reviews/*/thumbnail/*.{png,jpg,jpeg,webp,avif,gif,svg,PNG,JPG,JPEG,WEBP,AVIF,GIF,SVG}', {
	eager: true,
	import: 'default',
});
const thumbnailVideos = import.meta.glob<string>('/src/reviews/*/thumbnail/*.{mp4,webm,mov,m4v,ogv,MP4,WEBM,MOV,M4V,OGV}', {
	eager: true,
	query: '?url',
	import: 'default',
});
const pictureImages = import.meta.glob<ImageMetadata>('/src/reviews/*/pictures/*.{png,jpg,jpeg,webp,avif,gif,svg,PNG,JPG,JPEG,WEBP,AVIF,GIF,SVG}', {
	eager: true,
	import: 'default',
});
const pictureVideos = import.meta.glob<string>('/src/reviews/*/pictures/*.{mp4,webm,mov,m4v,ogv,MP4,WEBM,MOV,M4V,OGV}', {
	eager: true,
	query: '?url',
	import: 'default',
});

/** An image (optimized by Astro) or a video (played muted, looping, without controls). */
export type ReviewMedia = { type: 'image'; image: ImageMetadata } | { type: 'video'; src: string };

export interface Review {
	/** Folder name, used as the URL: /reviews/<slug>/ */
	slug: string;
	title: string;
	/** YYYY-MM-DD, exactly as written in date.txt. */
	date: string;
	/** Human readable date, e.g. "October 24, 2026". */
	dateLabel: string;
	thumbnail: ReviewMedia;
	/** Extra images/videos from the pictures/ folder, in alphabetical order by file name. May be empty. */
	pictures: ReviewMedia[];
	/** The rendered markdown. */
	Content: MarkdownInstance<Record<string, unknown>>['Content'];
	/** True when the markdown starts its own "# Title", so pages shouldn't add a second one. */
	hasTitleHeading: boolean;
	/** Plain-text summary for <meta name="description">. */
	description: string;
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
	year: 'numeric',
	month: 'long',
	day: 'numeric',
	// Dates are plain YYYY-MM-DD, so format in UTC to avoid off-by-one-day shifts.
	timeZone: 'UTC',
});

interface Found<T> {
	file: string;
	value: T;
}

/** Files belonging to one review folder, keyed by the folder name. */
function bySlug<T>(files: Record<string, T>): Map<string, Found<T>[]> {
	const grouped = new Map<string, Found<T>[]>();
	for (const path of Object.keys(files).sort()) {
		const slug = path.split('/')[3];
		const file = path.split('/').slice(4).join('/');
		grouped.set(slug, [...(grouped.get(slug) ?? []), { file, value: files[path] }]);
	}
	return grouped;
}

/** Images and videos from the same kind of folder, merged and grouped by review folder. */
function mediaBySlug(
	images: Record<string, ImageMetadata>,
	videos: Record<string, string>,
): Map<string, Found<ReviewMedia>[]> {
	const merged = new Map<string, Found<ReviewMedia>[]>();
	const add = (grouped: Map<string, Found<ReviewMedia>[]>) => {
		for (const [slug, items] of grouped) merged.set(slug, [...(merged.get(slug) ?? []), ...items]);
	};
	add(
		new Map(
			[...bySlug(images)].map(([slug, items]) => [
				slug,
				items.map(({ file, value }): Found<ReviewMedia> => ({ file, value: { type: 'image', image: value } })),
			]),
		),
	);
	add(
		new Map(
			[...bySlug(videos)].map(([slug, items]) => [
				slug,
				items.map(({ file, value }): Found<ReviewMedia> => ({ file, value: { type: 'video', src: value } })),
			]),
		),
	);
	return merged;
}

/** Exactly one of something per folder, with a helpful error otherwise. */
function expectOne<T>(
	items: Found<T>[] | undefined,
	slug: string,
	label: { missing: string; many: string; expected: string },
): T {
	if (!items || items.length === 0) {
		throw new Error(`[reviews] "${slug}" is missing ${label.missing}. Expected ${label.expected} in ${REVIEWS_DIR}/${slug}/.`);
	}
	if (items.length > 1) {
		const names = items.map((item) => item.file).join(', ');
		throw new Error(`[reviews] "${slug}" has ${items.length} ${label.many} (${names}), but only one is allowed.`);
	}
	return items[0].value;
}

function humanize(slug: string): string {
	return slug
		.replace(/[-_]+/g, ' ')
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

/** First real paragraph of the markdown, stripped of formatting, for meta descriptions. */
function summarize(markdown: string, fallback: string, maxLength = 160): string {
	const paragraph = markdown
		.replace(/```[\s\S]*?```/g, '')
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.find((block) => block && !/^(#|>|[-*+]\s|\d+\.\s|!\[|\||<)/.test(block));

	if (!paragraph) return fallback;

	const text = paragraph
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
}

/** Every review, newest first. */
export function getReviews(): Review[] {
	const markdown = bySlug(markdownFiles);
	const dates = bySlug(dateFiles);
	const thumbnails = mediaBySlug(thumbnailImages, thumbnailVideos);
	const pictures = mediaBySlug(pictureImages, pictureVideos);
	// A folder counts as a review as soon as it has any one of the three pieces,
	// so a half-finished folder gets a clear error instead of silently vanishing.
	const slugs = new Set([...markdown.keys(), ...dates.keys(), ...thumbnails.keys()]);

	const reviews = [...slugs].map((slug): Review => {
		const post = expectOne(markdown.get(slug), slug, {
			missing: 'a markdown file',
			many: 'markdown files',
			expected: 'one .md file',
		});
		const rawDate = expectOne(dates.get(slug), slug, {
			missing: 'date.txt',
			many: 'date files',
			expected: 'a date.txt file',
		}).trim();
		const thumbnail = expectOne(thumbnails.get(slug), slug, {
			missing: 'a thumbnail image or video',
			many: 'thumbnail files',
			expected: 'one image (png/jpg/webp/avif/gif/svg) or video (mp4/webm/mov) inside a thumbnail folder',
		});

		if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(new Date(rawDate).getTime())) {
			throw new Error(`[reviews] "${slug}" has an invalid date "${rawDate}" in date.txt. Use YYYY-MM-DD, e.g. 2026-10-24.`);
		}

		const title = post.getHeadings().find((heading) => heading.depth === 1)?.text.trim();

		return {
			slug,
			title: title || humanize(slug),
			date: rawDate,
			dateLabel: dateFormat.format(new Date(rawDate)),
			thumbnail,
			pictures: (pictures.get(slug) ?? [])
				// Skip macOS "._" metadata files that can ride along on external drives.
				.filter((picture) => !picture.file.split('/').pop()!.startsWith('._'))
				.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true, sensitivity: 'base' }))
				.map((picture) => picture.value),
			Content: post.Content,
			hasTitleHeading: Boolean(title),
			description: summarize(post.rawContent(), `A review of ${title || humanize(slug)}.`),
		};
	});

	// Newest first. Ties fall back to the folder name so the order is stable.
	return reviews.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}
