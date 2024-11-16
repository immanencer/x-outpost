import process from 'process';
import { Buffer } from 'buffer';

import sharp from 'sharp';
import { TwitterApi } from 'twitter-api-v2';

const xClient = new TwitterApi({
    appKey: process.env.TWITTER_APP_TOKEN,
    appSecret: process.env.TWITTER_APP_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Enhanced chunking function to split text into tweet-sized chunks prioritizing sentences and double line breaks
function chunkText(text, chunkSize = 280) {
    const paragraphs = text.split('\n\n'); // Split text into paragraphs first
    const chunks = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        const sentences = paragraph.split(/(?<=\.|\?|!)\s+/); // Split paragraph into sentences

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 > chunkSize) {
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }

                if (sentence.length > chunkSize) {
                    const words = sentence.split(' ');
                    for (const word of words) {
                        if (currentChunk.length + word.length + 1 > chunkSize) {
                            chunks.push(currentChunk.trim());
                            currentChunk = word;
                        } else {
                            currentChunk += ` ${word}`;
                        }
                    }
                } else {
                    currentChunk += ` ${sentence}`;
                }
            } else {
                currentChunk += ` ${sentence}`;
            }
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

// Function to delay execution (used for retries)
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to upload a single image buffer
async function uploadImageBuffer(buffer, type = 'png') {
    try {
        const mediaId = await xClient.v1.uploadMedia(Buffer.from(buffer), { mimeType: `image/${type}` });
        console.log('🌳 Image uploaded successfully:', mediaId);
        return mediaId;
    } catch (error) {
        console.error('🌳 Error uploading image:', error);
        throw error;
    }
}

// Enhanced function to post tweets with various options, image attachment, and error handling
export async function postX(params, inReplyTo = '', imageBuffer = null) {
    const { text, ...otherParams } = params;
    const tweetChunks = chunkText(text || '');

    let inReplyToTweetId = inReplyTo || null;
    let final_id = null;
    const maxRetries = 3;
    let mediaId = null;

    // Upload image if buffer is provided
    if (imageBuffer) {
        try {
            // if the image Buffer exceeds 5242880 bytes (5MB), it will be resized
            while (imageBuffer.length > 5242880) {
                console.log('🌳 Resizing image buffer...');

                // Get image metadata first
                const metadata = await sharp(imageBuffer).metadata();

                // Calculate new dimensions (80% of original)
                const newWidth = Math.floor(metadata.width * 0.8);
                const newHeight = Math.floor(metadata.height * 0.8);

                imageBuffer = await sharp(imageBuffer)
                    .resize(newWidth, newHeight)
                    .toBuffer();
            }

            mediaId = await uploadImageBuffer(imageBuffer);
        } catch (error) {
            console.error('🌳 Failed to upload image, proceeding without it.', error);
        }
    }

    for (const chunk of tweetChunks) {
        let success = false;
        let attempt = 0;

        // Wait for a few seconds between each chunk
        await delay(5000);

        while (attempt < maxRetries && !success) {
            try {
                const tweetPayload = {
                    text: chunk,
                    ...otherParams,
                    reply: inReplyToTweetId ? { in_reply_to_tweet_id: inReplyToTweetId } : undefined,
                };

                // Attach mediaId if available and it's the first chunk
                if (mediaId && inReplyToTweetId === null) {
                    tweetPayload.media = { media_ids: [mediaId] };
                }

                const response = await xClient.v2.tweet(tweetPayload);
                final_id = response.data.id;
                console.log('🌳 Tweet posted successfully:', response);
                await delay(1000); // Wait for a few seconds between each tweet

                // Update inReplyToTweetId for the next tweet in the thread
                inReplyToTweetId = response.data.id;
                success = true;
            } catch (error) {
                attempt++;
                console.error(`🌳 Error posting tweet (Attempt ${attempt}/${maxRetries}):`, error);

                if (error.code === 403 || error.code === 400) {
                    console.error('🌳 Invalid or forbidden tweet, skipping this chunk:', chunk);
                    success = true;
                    break;
                }

                if (error.rateLimit) {
                    const waitTime = error.rateLimit.reset * 1000 - Date.now();
                    console.log(`🌳 Rate limit reached, retrying after ${Math.ceil(waitTime / 60000)} minutes...`);
                    await delay(waitTime);
                } else {
                    console.log(`🌳 Retrying in ${attempt * 2} seconds...`);
                    await delay(attempt * 2000); // Exponential backoff
                }
            }
        }

        if (!success) {
            console.error('🌳 Failed to post tweet after multiple attempts, stopping further posts.');
            break;
        }
    }

    return final_id;
}

// Add this function to xpost.mjs

export async function likeTweet(tweetId) {
    const maxRetries = 3;
    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success) {
        try {
            await delay(5000); // Wait for a few seconds between each attempt
            const response = await xClient.v2.like(process.env.TWITTER_USER_ID, tweetId);
            console.log('🌳 Successfully liked tweet:', tweetId);
            success = true;
            return response;
        } catch (error) {
            attempt++;
            console.error(`🌳 Error liking tweet (Attempt ${attempt}/${maxRetries}):`, error);

            let waitTime = attempt * 2000; // Exponential backoff
            if (error.rateLimit) {
                waitTime = error.rateLimit.reset * 1000 - Date.now();
                console.log(`🌳 Rate limit reached, retrying after ${Math.ceil(waitTime / 60000)} minutes...`);
                await delay(waitTime);
            } else {
                console.log(`🌳 Retrying in ${attempt * 2} seconds...`);
                await delay(waitTime);
            }
        }
    }

    if (!success) {
        console.error('🌳 Failed to like tweet after multiple attempts.');
        throw new Error('Failed to like tweet after multiple attempts');
    }
}
