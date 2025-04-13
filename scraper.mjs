// scraper.mjs

import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

// Load environment variables from .env
dotenv.config();

// New API configuration
const XCACHE_API_BASE_URL = process.env.XCACHE_API_BASE_URL
const XCACHE_API_KEY = process.env.XCACHE_API_KEY;

// Constants
const TWEET_FIELDS = [
  'created_at',
  'text',
  'author_id',
  'attachments',
  'referenced_tweets',
  'in_reply_to_user_id',
  'entities',
  'conversation_id',
  'public_metrics',
  'context_annotations',
  'lang',
  'possibly_sensitive',
  'source',
  'geo'
];

const USER_FIELDS = [
  'username',
  'name',
  'profile_image_url',
  'description',
  'public_metrics',
  'created_at',
  'verified',
  'location'
];

const MEDIA_FIELDS = [
  'url',
  'preview_image_url',
  'type',
  'duration_ms',
  'height',
  'width',
  'alt_text',
  'variants'
];

const EXPANSIONS = [
  'attachments.media_keys',
  'referenced_tweets.id',
  'author_id',
  'in_reply_to_user_id',
  'entities.mentions.username'
];

// Configuration
const FETCH_INTERVAL = 1000 * 60 * 5; // 5 minutes
const AUTHOR_TWEET_LIMIT = 50;
const HOME_TIMELINE_MAX_RESULTS = 100;
const AUTHOR_UPDATE_INTERVAL = 72 * 1000 * 60 * 60; // 72 hours
const MENTION_FETCH_INTERVAL = 1000 * 60 * 10; // 10 minutes
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 60000;
const MONGODB_OPERATION_TIMEOUT = 30000;
const TWITTER_API_TIMEOUT = 10000;

// Twitter Client
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_APP_TOKEN,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
  timeout: TWITTER_API_TIMEOUT
});

// Utility function to pause execution with logging
function delay(ms) {
  console.log(`[${new Date().toISOString()}] Pausing for ${ms / 1000} seconds...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldIgnoreTweet(tweet) {
  const text = tweet.text;
  const hasNumbers = /\d/.test(text);
  const hasPump = /pump/i.test(text);
  const hasEthAddress = /0x[a-fA-F0-9]{40}/.test(text);
  const hasSolAddress = /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text);
  return (hasNumbers && hasPump) || hasEthAddress || hasSolAddress;
}

// Adaptive RateLimiter
class AdaptiveRateLimiter {
  constructor(maxRequests, perMilliseconds, minInterval = 1000) {
    this.maxRequests = maxRequests;
    this.perMilliseconds = perMilliseconds;
    this.minInterval = minInterval;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
    this.successCount = 0;
    this.failureCount = 0;
    this.backoffMultiplier = 1;
  }

  async removeTokens(count = 1) {
    await this.refillTokens();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    const waitTime = Math.min(
      (count - this.tokens) *
        (this.perMilliseconds / this.maxRequests) *
        this.backoffMultiplier,
      MAX_RETRY_DELAY
    );
    await delay(Math.max(waitTime, this.minInterval));
    await this.refillTokens();
    this.tokens -= count;
    return true;
  }

  async refillTokens() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.perMilliseconds) * this.maxRequests);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.tokens + tokensToAdd, this.maxRequests);
      this.lastRefill = now;
    }
  }

  recordSuccess() {
    this.successCount++;
    this.backoffMultiplier = Math.max(1, this.backoffMultiplier * 0.9);
  }

  recordFailure() {
    this.failureCount++;
    this.backoffMultiplier = Math.min(10, this.backoffMultiplier * 1.5);
  }
}

// Rate limiters
const rateLimiters = {
  homeTimeline: new AdaptiveRateLimiter(180, 15 * 60 * 1000),
  userTweets: new AdaptiveRateLimiter(900, 15 * 60 * 1000),
  searchTweets: new AdaptiveRateLimiter(450, 15 * 60 * 1000),
  userByUsername: new AdaptiveRateLimiter(300, 15 * 60 * 1000),
  xCacheAPI: new AdaptiveRateLimiter(180, 15 * 60 * 1000)
};

// MongoDB connection
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: MONGODB_OPERATION_TIMEOUT,
    maxIdleTimeMS: 60000,
    retryWrites: true,
    w: 'majority'
  });

  try {
    await client.connect();
    console.log('[MongoDB] Connected successfully');
    const db = client.db(process.env.DB_NAME);
    await setupDatabaseIndexes(db);
    return db;
  } catch (error) {
    console.error('[MongoDB] Connection error:', error);
    throw error;
  }
}

// Setup indexes
async function setupDatabaseIndexes(db) {
  try {
    const indexOperations = [
      {
        collection: 'tweets',
        indexes: [
          {
            key: { id: 1 },
            options: { unique: true, name: 'tweet_id_unique' }
          },
          {
            key: { created_at: 1 },
            options: {
              expireAfterSeconds: 30 * 24 * 60 * 60,
              name: 'tweet_ttl'
            }
          },
          {
            key: { author_id: 1, created_at: -1 },
            options: { name: 'tweet_author_date' }
          },
          {
            key: { conversation_id: 1 },
            options: { name: 'tweet_conversation' }
          },
          {
            key: { text: 'text' },
            options: { name: 'tweet_text_search' }
          }
        ]
      },
      {
        collection: 'authors',
        indexes: [
          {
            key: { id: 1 },
            options: { unique: true, name: 'author_id_unique' }
          },
          {
            key: { username: 1 },
            options: { name: 'author_username' }
          },
          {
            key: { lastFetched: 1 },
            options: { name: 'author_last_fetched' }
          }
        ]
      },
      {
        collection: 'media',
        indexes: [
          {
            key: { media_key: 1 },
            options: { unique: true, name: 'media_key_unique' }
          },
          {
            key: { type: 1 },
            options: { name: 'media_type' }
          }
        ]
      }
    ];

    for (const { collection, indexes } of indexOperations) {
      console.log(`[MongoDB] Setting up indexes for ${collection} collection...`);
      for (const { key, options } of indexes) {
        try {
          const existingIndexes = await db.collection(collection).listIndexes().toArray();
          const indexExists = existingIndexes.some((idx) =>
            Object.keys(idx.key).every((k) => idx.key[k] === key[k])
          );
          if (!indexExists) {
            await db.collection(collection).createIndex(key, {
              background: true,
              ...options
            });
            console.log(`[MongoDB] Created index ${options.name} on ${collection}`);
          } else {
            console.log(
              `[MongoDB] Index already exists for ${JSON.stringify(key)} on ${collection}, skipping...`
            );
          }
        } catch (indexError) {
          console.error(
            `[MongoDB] Error creating index ${options.name} on ${collection}:`,
            indexError
          );
          continue;
        }
      }
    }
    console.log('[MongoDB] Index setup completed');
  } catch (error) {
    console.error('[MongoDB] Index setup error:', error);
    console.log('[MongoDB] Continuing with existing indexes...');
  }
}

// Twitter call with retry
async function retryTwitterCall(apiCall, limiter, retryCount = 0) {
  try {
    await limiter.removeTokens();
    const result = await apiCall();
    limiter.recordSuccess();
    return result;
  } catch (error) {
    limiter.recordFailure();
    if (error.code === 429 || (error.status === 503 && retryCount < MAX_RETRIES)) {
      const resetTime = error.rateLimit?.reset
        ? error.rateLimit.reset * 1000
        : Date.now() +
          Math.min(INITIAL_RETRY_DELAY * Math.pow(2, retryCount), MAX_RETRY_DELAY);
      const waitTime = Math.max(resetTime - Date.now(), INITIAL_RETRY_DELAY);
      console.error(
        `[Twitter] Rate limit exceeded. Attempt ${retryCount + 1}/${MAX_RETRIES}. Waiting ${
          waitTime / 1000
        }s...`
      );
      await delay(waitTime);
      return retryTwitterCall(apiCall, limiter, retryCount + 1);
    }
    console.error('[Twitter] API error:', error);
    throw error;
  }
}

// Fetch a single tweet using the conversations endpoint and extract only the specific tweet
async function fetchSingleTweetFromXCache(tweetId) {
  const url = `${XCACHE_API_BASE_URL}/api/v1/conversations/${tweetId}`;
  
  try {
    await rateLimiters.xCacheAPI.removeTokens();
    console.log(`[XCACHE] Fetching tweet ${tweetId} via conversations endpoint`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-KEY': XCACHE_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: TWITTER_API_TIMEOUT
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    rateLimiters.xCacheAPI.recordSuccess();
    
    // Extract only the specific tweet we requested from the response
    if (data && data.data && Array.isArray(data.data)) {
      // Find the specific tweet with our requested ID
      const targetTweet = data.data.find(tweet => tweet.id === tweetId);
      
      if (targetTweet) {
        // Ensure author_id is set properly
        if (targetTweet.author && targetTweet.author.id) {
          targetTweet.author_id = targetTweet.author.id;
        }
        
        // Return only this tweet in the expected format
        return {
          data: [targetTweet],
          includes: data.includes // Keep the includes as they may contain relevant author info
        };
      }
    }
    
    // If we couldn't find the specific tweet
    console.warn(`[XCACHE] Couldn't extract tweet ${tweetId} from conversation response`);
    return null;
  } catch (error) {
    rateLimiters.xCacheAPI.recordFailure();
    console.error(`[XCACHE] Error fetching tweet ${tweetId}:`, error);
    throw error;
  }
}


// Fetch mentions from X-Cache API
async function fetchMentionsFromXCache(sinceId = null) {
  const username = process.env.TWITTER_USERNAME || 'theerebusai';
  let url = `${XCACHE_API_BASE_URL}/api/v1/users/${username}/mentions`;
  
  if (sinceId) {
    url += `?since_id=${sinceId}`;
  }
  
  try {
    await rateLimiters.xCacheAPI.removeTokens();
    console.log(`[XCACHE] Fetching mentions for @${username} from: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-KEY': XCACHE_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: TWITTER_API_TIMEOUT
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    rateLimiters.xCacheAPI.recordSuccess();
    
    // Transform the data structure to match what existing code expects
    if (data && data.data && Array.isArray(data.data)) {
      data.data = data.data.map(tweet => {
        // Extract author.id into author_id field for compatibility
        if (tweet.author && tweet.author.id) {
          tweet.author_id = tweet.author.id;
        }
        return tweet;
      });
    }
    
    return data;
  } catch (error) {
    rateLimiters.xCacheAPI.recordFailure();
    console.error('[XCACHE] Error fetching mentions:', error);
    throw error;
  }
}

// Get user data by ID from Twitter
async function fetchUserById(authorId) {
  try {
    const response = await retryTwitterCall(
      () =>
        twitterClient.v2.user(authorId, {
          'user.fields': USER_FIELDS
        }),
      rateLimiters.userByUsername
    );
    return response?.data || null;
  } catch (error) {
    if (error.code === 50 || error.code === 404) {
      console.warn(`[AuthorService] User not found by ID: ${authorId}`);
      return null;
    }
    console.error(`[AuthorService] fetchUserById error for ID ${authorId}:`, error);
    return null;
  }
}

// Add or update author in DB
async function addOrUpdateAuthor(db, authorData) {
  try {
    const authorsCollection = db.collection('authors');
    let authorId = authorData.id;
    if (!authorId && authorData.username) {
      authorId = `temp_${uuidv4()}`;
      console.warn(`[MongoDB] Author @${authorData.username} missing ID. Assigned temp ID: ${authorId}`);
    }
    if (!authorId) {
      throw new Error('Cannot add/update author without id or username');
    }
    await authorsCollection.updateOne(
      { id: authorId },
      {
        $set: {
          username: authorData.username,
          lastFetched: new Date(),
          ...(authorData.profile_image_url && { profile_image_url: authorData.profile_image_url }),
          ...(authorData.public_metrics && {
            followers_count: authorData.public_metrics.followers_count,
            tweet_count: authorData.public_metrics.tweet_count
          }),
          ...authorData
        }
      },
      { upsert: true }
    );
    console.log(`[MongoDB] Updated author: @${authorData.username} (ID: ${authorId})`);
  } catch (error) {
    console.error('[MongoDB] Error updating author:', error);
    throw error;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// AuthorService: ensures authors are enriched from Twitter
// ────────────────────────────────────────────────────────────────────────────
class AuthorService {
  constructor(db) {
    this.db = db;
  }

  /**
   * For each tweet, gather the authors. If we lack their info or it's stale,
   * fetch from Twitter and update DB. This ensures the context generator
   * won't need to talk to Twitter directly.
   */
  async collectAuthorsFromTweets(tweets) {
    if (!tweets || !tweets.length) return;
    const authorIds = [
      ...new Set(tweets.map((tweet) => tweet.author_id).filter(Boolean))
    ];
    if (!authorIds.length) {
      console.log('[AuthorService] No author IDs to collect.');
      return;
    }
    console.log(`[AuthorService] Collecting/updating info for ${authorIds.length} authors...`);

    for (const authorId of authorIds) {
      try {
        const existing = await this.db.collection('authors').findOne({ id: authorId });
        const isStale =
          !existing?.lastFetched ||
          Date.now() - new Date(existing.lastFetched).getTime() > 24 * 3600 * 1000 * 7; // 1 week
        if (!existing || isStale) {
          // fetch from Twitter
          const userData = await fetchUserById(authorId);
          if (userData) {
            await addOrUpdateAuthor(this.db, userData);
          }
        }
      } catch (err) {
        console.error(`[AuthorService] Error refreshing author ${authorId}:`, err);
      }
    }
  }
}
// ────────────────────────────────────────────────────────────────────────────

async function addTweetToMongoDB(db, tweets, includes) {
  const bulkOps = {
    tweets: [],
    authors: [],
    media: []
  };

  for (const tweet of tweets) {
    // Process media
    if (tweet.attachments?.media_keys && includes?.media) {
      const mediaData = includes.media.filter((m) => tweet.attachments.media_keys.includes(m.media_key));
      if (mediaData.length > 0) {
        tweet.mediaData = mediaData;
        bulkOps.media.push(
          ...mediaData.map((media) => ({
            updateOne: {
              filter: { media_key: media.media_key },
              update: { $set: media },
              upsert: true
            }
          }))
        );
      }
    }
    // Process mentions and authors
    if (tweet.entities?.mentions) {
      for (const mention of tweet.entities.mentions) {
        if (mention.id) {
          bulkOps.authors.push({
            updateOne: {
              filter: { id: mention.id },
              update: { $set: { username: mention.username } },
              upsert: true
            }
          });
        } else if (mention.username) {
          const tempId = `temp_${uuidv4()}`;
          bulkOps.authors.push({
            updateOne: {
              filter: { id: tempId },
              update: { $set: { username: mention.username } },
              upsert: true
            }
          });
        }
      }
    }
    // Add tweet only if it should not be ignored
    if (shouldIgnoreTweet(tweet)) {
      console.log(`[Filter] Ignoring tweet ${tweet.id} due to content: ${tweet.text.substring(0, 50)}...`);
    } else {
      bulkOps.tweets.push({
        updateOne: {
          filter: { id: tweet.id },
          update: { $set: tweet },
          upsert: true
        }
      });
    }
  }

  try {
    // Bulk-write in parallel
    await Promise.all([
      bulkOps.tweets.length && db.collection('tweets').bulkWrite(bulkOps.tweets),
      bulkOps.authors.length && db.collection('authors').bulkWrite(bulkOps.authors),
      bulkOps.media.length && db.collection('media').bulkWrite(bulkOps.media)
    ]);
    console.log('[MongoDB] Bulk operations completed successfully');
  } catch (error) {
    console.error('[MongoDB] Bulk operation error:', error);
    throw error;
  }
}

// Mentions search using XCACHE API
async function searchAuthenticatedUserMentions(authUser, sinceId) {
  try {
    console.log(`[XCACHE] Searching mentions for @${authUser.username}`);
    return await fetchMentionsFromXCache(sinceId);
  } catch (error) {
    console.error(`[XCACHE] Error searching mentions:`, error);
    throw error;
  }
}

// Main mentions fetch cycle
async function startMentionsFetchCycle(db, authUser, authorService) {
  const mentionsCollection = db.collection('tweets');
  while (true) {
    try {
      console.log('[Mentions] Starting mentions fetch...');
      const mostRecentMention = await mentionsCollection
        .find({ 'entities.mentions.username': authUser.username })
        .sort({ created_at: -1 })
        .limit(1)
        .toArray();
      const sinceId = mostRecentMention.length > 0 ? mostRecentMention[0].id : null;

      const mentions = await searchAuthenticatedUserMentions(authUser, sinceId);
      if (mentions.data) {
        const newTweets = mentions.data;
        await addTweetToMongoDB(db, newTweets, mentions.includes);

        // ── Enrich authors here ──
        await authorService.collectAuthorsFromTweets(newTweets);
        
        console.log(`[Mentions] Processed ${newTweets.length} new mentions`);
      } else {
        console.log('[Mentions] No new mentions found');
      }

      await delay(MENTION_FETCH_INTERVAL);
    } catch (error) {
      console.error('[Mentions] Error in mentions fetch cycle:', error);
      await delay(INITIAL_RETRY_DELAY);
    }
  }
}

// Home timeline
async function getHomeTimeline(lastId) {
  const params = {
    max_results: HOME_TIMELINE_MAX_RESULTS,
    since_id: lastId,
    expansions: EXPANSIONS.join(','),
    'media.fields': MEDIA_FIELDS.join(','),
    'tweet.fields': TWEET_FIELDS.join(','),
    'user.fields': USER_FIELDS.join(',')
  };
  console.log('[Twitter] Requesting home timeline:', params);
  return await retryTwitterCall(() => twitterClient.v2.homeTimeline(params), rateLimiters.homeTimeline);
}

// Optimized function to process only tweets with missing parents
async function processConversationThreads(db, authorService) {
  const tweetsCollection = db.collection('tweets');
  
  console.log('[ConversationProcessor] Starting optimized conversation thread processing...');
  
  try {
    // The magic happens here - we use MongoDB aggregation to find only tweets
    // that reference parent tweets that aren't in our database yet
    const pipeline = [
      // Stage 1: Unwind the referenced_tweets array to work with each reference individually
      { $unwind: '$referenced_tweets' },
      
      // Stage 2: Filter to only include "replied_to" references
      { $match: { 'referenced_tweets.type': 'replied_to' } },
      
      // Stage 3: Group by the referenced tweet ID to avoid duplicates
      { $group: { 
          _id: '$referenced_tweets.id',
          tweetId: { $first: '$id' },
          conversationId: { $first: '$conversation_id' },
          referencedId: { $first: '$referenced_tweets.id' }
      }},
      
      // Stage 4: Perform a lookup to see if the referenced tweet exists in our collection
      { $lookup: {
          from: 'tweets',
          localField: 'referencedId',
          foreignField: 'id',
          as: 'parentTweet'
      }},
      
      // Stage 5: Filter to only include references where the parent tweet doesn't exist
      { $match: { 'parentTweet': { $size: 0 } } },
      
      // Stage 6: Limit the number we process at once
      { $limit: 50 }
    ];
    
    const missingParents = await tweetsCollection.aggregate(pipeline).toArray();
    
    console.log(`[ConversationProcessor] Found ${missingParents.length} tweets with missing parents`);
    
    if (missingParents.length === 0) {
      return;
    }
    
    // Extract the IDs of the missing parent tweets
    const missingParentIds = missingParents.map(item => item.referencedId);
    
    console.log(`[ConversationProcessor] Will fetch these missing parent tweets: ${missingParentIds.join(', ')}`);
    
    // Fetch and store each missing parent tweet
    for (const parentId of missingParentIds) {
      try {
        const tweetData = await fetchSingleTweetFromXCache(parentId);
        
        if (tweetData && tweetData.data && tweetData.data.length > 0) {
          // Store the tweet in MongoDB
          await addTweetToMongoDB(db, tweetData.data, tweetData.includes);
          
          // Enrich author information
          await authorService.collectAuthorsFromTweets(tweetData.data);
          
          console.log(`[ConversationProcessor] Added parent tweet ${parentId} to database`);
          
          // Check if this newly added tweet is also a reply
          // If so, it will be picked up in the next processing cycle
        }
      } catch (error) {
        console.error(`[ConversationProcessor] Error fetching parent tweet ${parentId}:`, error);
      }
      
      // Apply a small delay between API calls to avoid rate limiting
      await delay(1000);
    }
    
    console.log(`[ConversationProcessor] Completed conversation thread processing`);
  } catch (error) {
    console.error('[ConversationProcessor] Error during conversation processing:', error);
  }
}


// Start the conversation processor on a different schedule
async function startConversationProcessingCycle(db, authorService) {
  const CONVERSATION_PROCESSING_INTERVAL = 1000 * 60 * 15; // 15 minutes
  
  while (true) {
    try {
      await processConversationThreads(db, authorService);
      await delay(CONVERSATION_PROCESSING_INTERVAL);
    } catch (error) {
      console.error('[ConversationProcessor] Error in processing cycle:', error);
      await delay(INITIAL_RETRY_DELAY);
    }
  }
}

// Main timeline fetch cycle
async function startMainFetchCycle(db, authUser, authorService) {
  const tweetsCollection = db.collection('tweets');
  while (true) {
    try {
      console.log('[Main] Starting timeline fetch...');
      const mostRecentTweet = await tweetsCollection.findOne({}, { sort: { created_at: -1 } });
      const timeline = await getHomeTimeline(mostRecentTweet?.id);

      if (timeline.data?.data) {
        const newTweets = timeline.data.data;
        await addTweetToMongoDB(db, newTweets, timeline.includes);

        // ── Enrich authors here ──
        await authorService.collectAuthorsFromTweets(newTweets);

        console.log(`[Main] Processed ${newTweets.length} new tweets`);
      } else {
        console.log('[Main] No new tweets found');
      }

      await delay(FETCH_INTERVAL);
    } catch (error) {
      console.error('[Main] Error in main fetch cycle:', error);
      await delay(INITIAL_RETRY_DELAY);
    }
  }
}

// Background processes (unchanged)
const BATCH_SIZE = 50;
async function processUnknownAuthorsQueue(db, batchSize = BATCH_SIZE) {
  const authorsCollection = db.collection('authors');
  const tempAuthors = await authorsCollection.find({ id: /^temp_/ }).limit(batchSize).toArray();
  console.log(`[Background] Processing ${tempAuthors.length} temporary authors...`);

  for (const tempAuthor of tempAuthors) {
    try {
      if (!tempAuthor.username) continue;
      const currentAuthor = await authorsCollection.findOne({ id: tempAuthor.id });
      if (!currentAuthor || !currentAuthor.id.startsWith('temp_')) continue;

      // Possibly fetch user data by username if we only have a temp ID
      const userData = await retryTwitterCall(
        () => twitterClient.v2.userByUsername(tempAuthor.username, { 'user.fields': USER_FIELDS }),
        rateLimiters.userByUsername
      );
      if (userData?.data) {
        await authorsCollection.updateOne(
          { id: tempAuthor.id },
          {
            $set: {
              id: userData.data.id,
              username: userData.data.username,
              lastFetched: new Date()
            }
          }
        );
        console.log(
          `[Background] Updated temp author @${tempAuthor.username} with real ID: ${userData.data.id}`
        );
      }
    } catch (error) {
      if (error.code === 429) {
        console.log('[Background] Rate limit hit, will retry in next batch');
        break;
      }
      console.error(`[Background] Error processing temp author @${tempAuthor.username}:`, error);
    }
  }
}

async function startBackgroundProcesses(db) {
  while (true) {
    try {
      console.log('[Background] Starting background processes...');
      await processUnknownAuthorsQueue(db, BATCH_SIZE);
      console.log(
        `[Background] Waiting ${AUTHOR_UPDATE_INTERVAL / 1000}s before next update...`
      );
      await delay(AUTHOR_UPDATE_INTERVAL);
    } catch (error) {
      console.error('[Background] Error in background processes:', error);
      await delay(INITIAL_RETRY_DELAY);
    }
  }
}

// Get authenticated user
async function getAuthenticatedUser(db) {
  try {
    // Get the user ID from environment variable
    const authUserId = process.env.TWITTER_USER_ID;
    
    if (!authUserId) {
      console.warn('[Config] TWITTER_USER_ID not found in environment variables');
    }
    
    // First check if we have the authenticated user in our database
    if (db && authUserId) {
      console.log(`[MongoDB] Looking up authenticated user by ID: ${authUserId}`);
      const authorsCollection = db.collection('authors');
      const storedUser = await authorsCollection.findOne({ id: authUserId });
      
      if (storedUser) {
        const isStale = !storedUser.lastFetched || 
          Date.now() - new Date(storedUser.lastFetched).getTime() > 24 * 3600 * 1000; // 1 day
        
        if (!isStale) {
          console.log(`[MongoDB] Using cached authenticated user: @${storedUser.username}`);
          return storedUser;
        }
        console.log('[MongoDB] Cached authenticated user is stale, refreshing from Twitter...');
      } else {
        console.log(`[MongoDB] No user found with ID: ${authUserId}`);
      }
    }

    // Fallback to Twitter API if not in DB or stale
    console.log('[Twitter] Fetching authenticated user info...');
    const user = await retryTwitterCall(
      () => twitterClient.v2.me({ 'user.fields': USER_FIELDS }),
      rateLimiters.userByUsername
    );

    console.log(`[Twitter] Authenticated as: @${user.data.username} (ID: ${user.data.id})`);
    
    // Store in database with updated timestamp
    if (db) {
      await db.collection('authors').updateOne(
        { id: user.data.id },
        { 
          $set: { 
            ...user.data,
            lastFetched: new Date()
          } 
        },
        { upsert: true }
      );
    }
    
    return user.data;
  } catch (error) {
    console.error('[Twitter] Error fetching authenticated user info:', error);
    throw error;
  }
}

// Main
async function main() {
  let db;
  try {
    // Check env
    const requiredEnvVars = [
      'TWITTER_APP_TOKEN',
      'TWITTER_APP_SECRET',
      'TWITTER_ACCESS_TOKEN',
      'TWITTER_ACCESS_SECRET',
      'MONGODB_URI',
      'DB_NAME',
      'XCACHE_API_BASE_URL',
      'XCACHE_API_KEY'
    ];
    const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
    if (missingVars.length) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    // Connect
    db = await connectToMongoDB();

    // Auth user
    const authUser = await getAuthenticatedUser(db);
    // Store our own bot user in authors as well
    await addOrUpdateAuthor(db, authUser);

    // Initialize AuthorService
    const authorService = new AuthorService(db);

    // Start main cycles
    if (process.env.FETCH_X_TIMELINE.toLowerCase !== 'false') {
      startMainFetchCycle(db, authUser, authorService);
    }
    if (process.env.FETCH_X_MENTIONS.toLowerCase !== 'false') {
      startMentionsFetchCycle(db, authUser, authorService);
    }

    // Start conversation processing cycle
    startConversationProcessingCycle(db, authorService);
    

    // Delayed background stuff
    setTimeout(() => {
      startBackgroundProcesses(db);
    }, AUTHOR_UPDATE_INTERVAL);
  } catch (error) {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

// Graceful shutdown
const shutdownHandlers = {
  SIGINT: () => handleShutdown('SIGINT'),
  SIGTERM: () => handleShutdown('SIGTERM')
};
Object.entries(shutdownHandlers).forEach(([signal, handler]) => {
  process.on(signal, handler);
});

async function handleShutdown(signal) {
  console.log(`\n[Process] Received ${signal}. Starting graceful shutdown...`);
  try {
    console.log('[Process] Cleanup completed. Exiting...');
    process.exit(0);
  } catch (error) {
    console.error('[Process] Error during shutdown:', error);
    process.exit(1);
  }
}

// Kick off the scraper
main().catch((error) => {
  console.error('[Fatal] Unhandled error:', error);
  process.exit(1);
});
