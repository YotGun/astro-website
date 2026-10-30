import type { ImageMetadata, MarkdownInstance } from 'astro';

/**
 * Reviews live in src/reviews/<url>/ (the folder name becomes /reviews/<url>):
 *
 *   src/reviews/<url>/
 *     review.md        the review text (any single .md file works)
 *     date.txt         the date posted, as YYYY-MM-DD
 *     thumbnail/       exactly one image (png, jpg, webp, avif, gif or svg)
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
const thumbnailFiles = import.meta.glob<ImageMetadata>(
	'/src/reviews/*/thumbnail/*.{png,jpg,jpeg,webp,avif,gif,svg,PNG,JPG,JPEG,WEBP,AVIF,GIF,SVG}',
	{ eager: true, import: 'default' },
);

export interface Review {
	/** Folder name, used as the URL: /reviews/<slug>/ */
	slug: string;
	title: string;
	/** YYYY-MM-DD, exactly as written in date.txt. */
	date: string;
	/** Human readable date, e.g. "October 24, 2026". */
	dateLabel: string;
	thumbnail: ImageMetadata;
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
	const thumbnails = bySlug(thumbnailFiles);
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
			missing: 'a thumbnail image',
			many: 'thumbnail images',
			expected: 'one png/jpg/webp/avif/gif/svg inside a thumbnail folder',
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
			Content: post.Content,
			hasTitleHeading: Boolean(title),
			description: summarize(post.rawContent(), `A review of ${title || humanize(slug)}.`),
		};
	});

	// Newest first. Ties fall back to the folder name so the order is stable.
	return reviews.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}
