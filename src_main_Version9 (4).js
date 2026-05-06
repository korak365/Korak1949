// Playwright-based BeReal Public Discovery Scraper
import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestList } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = ['https://bereal.com/discovery'],
    maxRequestsPerCrawl = 200,
    scrollIterations = 8,
    authMethod = 'none',
    cookieString = '',
    downloadImages = true,
    dedupe = true,
} = input;

// Proxy configuration (recommended)
const proxyConfiguration = await Actor.createProxyConfiguration();

// RequestList
const requestList = await RequestList.open('start-urls', startUrls);

// Key-Value store for images and dedupe
const kvStore = await Actor.openKeyValueStore();
let seenPostIds = (await kvStore.getValue('seenPostIds')) || [];
const seenSet = new Set(seenPostIds);

const crawler = new PlaywrightCrawler({
    requestList,
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: {
        launchOptions: { headless: true },
    },
    async preNavigationHooks({ page, request, log }) {
        if (authMethod === 'cookie' && cookieString) {
            log.info('Applying cookies for bereal.com');
            try {
                const cookies = cookieString.split(';').map((c) => {
                    const [name, ...v] = c.trim().split('=');
                    return { name, value: v.join('='), domain: '.bereal.com', path: '/' };
                });
                await page.context().addCookies(cookies);
            } catch (e) {
                log.warning('Failed to parse/apply cookie string', { error: e.message });
            }
        } else if (authMethod === 'credentials') {
            log.warning('authMethod=credentials selected but login flow is not implemented in this starter.');
        }
    },
    async requestHandler({ page, request, enqueueLinks, log }) {
        log.info('Visiting', { url: request.url });

        // Scroll to load discovery posts
        for (let i = 0; i < scrollIterations; i++) {
            await page.evaluate(() => { window.scrollBy(0, window.innerHeight); });
            await page.waitForTimeout(800 + Math.random() * 1200);
        }

        // Enqueue post pages (heuristic selector—adjust if needed)
        await enqueueLinks({
            selector: 'a[href*="/post/"], a[data-test-id="post"]',
            globs: ['**/post/**'],
            userData: { type: 'post' },
        });

        const url = request.url;
        if (url.includes('/post/')) {
            // Extract post id from URL or fallback to timestamp
            const match = url.match(/\/post\/([^/?#]+)/);
            const postId = match ? match[1] : `post-${Date.now()}`;

            // Extract username, caption, timestamp, and image(s) with fallbacks
            const username = await page.$eval('[data-username], .username, [data-test="username"]', el => el.textContent.trim()).catch(() => null);
            const caption = await page.$eval('.caption, [data-test="caption"], p', el => el.textContent.trim()).catch(() => null);
            const timestamp = await page.$eval('time, [data-test="time"]', el => el.getAttribute('datetime') || el.textContent.trim()).catch(() => null);

            // Collect image URLs (common img tags or background-image)
            const imageUrls = await page.$$eval('img', imgs => imgs.map(i => i.src).filter(Boolean)).catch(() => []);
            // Fallback: look for inline styles with background-image
            if (!imageUrls || imageUrls.length === 0) {
                const bgUrls = await page.$$eval('*[style*="background-image"]', els => els.map(e => {
                    const m = e.style.backgroundImage.match(/url\\((?:\\"|\\'|)(.*?)(?:\\"|\\'|)\\)/);
                    return m ? m[1] : null;
                }).filter(Boolean)).catch(() => []);
                if (bgUrls && bgUrls.length) imageUrls.push(...bgUrls);
            }

            const postUrl = url;

            // Deduplicate by postId if requested
            if (dedupe && seenSet.has(postId)) {
                log.info('Post already seen, skipping', { postId });
            } else {
                // Optionally download images to Key-Value store
                const imageKvKeys = [];
                if (downloadImages && imageUrls && imageUrls.length) {
                    for (let i = 0; i < imageUrls.length; i++) {
                        const imgUrl = imageUrls[i];
                        try {
                            log.info('Downloading image', { imgUrl });
                            const res = await fetch(imgUrl);
                            if (res.ok) {
                                const ab = await res.arrayBuffer();
                                const buffer = Buffer.from(ab);
                                const extMatch = (imgUrl.match(/\\.([a-z0-9]{3,4})(?:[?#]|$)/i) || [])[1] || 'jpg';
                                const key = `images/${postId}-${i}.${extMatch}`;
                                await kvStore.setValue(key, buffer);
                                imageKvKeys.push(key);
                                log.info('Saved image to Key-Value', { key });
                            } else {
                                log.warning('Image fetch returned non-OK status', { status: res.status, url: imgUrl });
                            }
                        } catch (e) {
                            log.warning('Failed to download/save image', { error: e.message, imageUrl: imgUrl });
                        }
                    }
                }

                // Push metadata to dataset
                await Dataset.pushData({
                    postId,
                    username,
                    caption,
                    timestamp,
                    imageUrls,
                    imageKvKeys,
                    postUrl,
                    crawledAt: new Date().toISOString(),
                });

                log.info('Pushed post metadata', { postId });

                if (dedupe) {
                    seenSet.add(postId);
                    await kvStore.setValue('seenPostIds', Array.from(seenSet)).catch(e => log.warning('Failed to persist seenPostIds', { error: e.message }));
                }
            }
        }
    },
    failedRequestHandler: async ({ request, log }) => {
        log.error('Request failed', { url: request.url });
    },
});

await crawler.run();

// Persist seenSet on exit
if (seenSet.size) {
    await kvStore.setValue('seenPostIds', Array.from(seenSet)).catch(e => console.warn('Failed to persist seenPostIds', e.message));
}

await Actor.exit();