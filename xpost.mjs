import process from 'process';
import { Buffer } from 'buffer';

import sharp from 'sharp';
import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv'; // Import dotenv
dotenv.config(); // Load environment variables from .env

const xClient = new TwitterApi({
    appKey: process.env.TWITTER_APP_TOKEN,
    appSecret: process.env.TWITTER_APP_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

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
            while (imageBuffer.length > 5242880) {
                console.log('🌳 Resizing image buffer...');
                const metadata = await sharp(imageBuffer).metadata();
                const newWidth = Math.floor(metadata.width * 0.8);
                const newHeight = Math.floor(metadata.height * 0.8);

                imageBuffer = await sharp(imageBuffer)
                    .resize(newWidth, newHeight)
                    .toBuffer();
            }
            mediaId = await uploadImageBuffer(imageBuffer);
        } catch (error) {
            console.error('🌳 Image upload failed; proceeding without attachment:', error);
        }
    }

    for (const chunk of tweetChunks) {
        let attempt = 0;
        let success = false;

        // Ensure a delay between tweets
        if (attempt > 0) await delay(5000);

        while (attempt < maxRetries && !success) {
            attempt++;
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
                console.log(`🌳 Tweet posted successfully: ${response.data.id}`);
                final_id = response.data.id;

                // Update for next tweet in the thread
                inReplyToTweetId = response.data.id;
                success = true;
            } catch (error) {
                console.error(`🌳 Error posting tweet (Attempt ${attempt}/${maxRetries}):`, error);


                if ([400, 403].includes(error.code)) {
                    console.error(`🌳 Non-recoverable error: Skipping chunk due to invalid tweet.`);
                    success = true; // Skip this chunk and continue
                } else {
                    if (error.rateLimit) {
                        const waitTime = (error.rateLimit.reset * 1000) - Date.now();
                        console.log(`🌳 Rate limit hit. Waiting ${Math.ceil(waitTime / 60000)} minutes...`);
                        await delay(waitTime);
                    } else {
                        const backoffTime = attempt * 2000;
                        console.log(`🌳 Retrying in ${backoffTime / 1000}s...`);
                        await delay(backoffTime);
                    }
                }
            }
        }

        if (!success) {
            console.error(`🌳 Failed to post tweet after ${maxRetries} attempts. Stopping further posts.`);
            break;
        }
    }

    return final_id;
}

/**
 * Utility function to chunk long text into smaller tweets
 */
function chunkText(text, maxLen = 280) {
    const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 0); // Preserve paragraphs
    const chunks = [];
    let currentChunk = "";
  
    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length + 2 <= maxLen) {
        // Add paragraph to current chunk if it fits
        currentChunk += (currentChunk.length ? "\n\n" : "") + paragraph;
      } else {
        // If paragraph doesn't fit, push the current chunk and start a new one
        if (currentChunk) chunks.push(currentChunk);
        if (paragraph.length > maxLen) {
          // If a single paragraph is still too long, split by sentence
          const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
          let subChunk = "";
          for (const sentence of sentences) {
            if (subChunk.length + sentence.length + 1 <= maxLen) {
              subChunk += (subChunk.length ? " " : "") + sentence;
            } else {
              chunks.push(subChunk);
              subChunk = sentence;
            }
          }
          if (subChunk) chunks.push(subChunk);
        } else {
          chunks.push(paragraph);
        }
        currentChunk = "";
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }
  
/**
 * Utility function for delay
 */
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
