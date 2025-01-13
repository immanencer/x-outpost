// scraper.mjs

import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables from .env file
dotenv.config();

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
const FETCH_INTERVAL = 1000 * 60 * 5; // 5 minutes - more frequent updates
const AUTHOR_TWEET_LIMIT = 50; // Increased from 10
const HOME_TIMELINE_MAX_RESULTS = 100;
const AUTHOR_UPDATE_INTERVAL = 72 * 1000 * 60 * 60; // 72 hour
const MENTION_FETCH_INTERVAL = 1000 * 60 * 10; // 10 minutes
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 60000;
const MONGODB_OPERATION_TIMEOUT = 30000;
const TWITTER_API_TIMEOUT = 10000;

// Initialize Twitter client with timeout
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_APP_TOKEN,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
  timeout: TWITTER_API_TIMEOUT
});

// Enhanced Rate Limiter with Adaptive Features
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
      (count - this.tokens) * (this.perMilliseconds / this.maxRequests) * this.backoffMultiplier,
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
    const tokensToAdd = Math.floor(
      (elapsed / this.perMilliseconds) * this.maxRequests
    );

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

// Initialize Rate Limiters with Twitter v2 API limits
const rateLimiters = {
  homeTimeline: new AdaptiveRateLimiter(180, 15 * 60 * 1000),
  userTweets: new AdaptiveRateLimiter(900, 15 * 60 * 1000),
  searchTweets: new AdaptiveRateLimiter(450, 15 * 60 * 1000),
  userByUsername: new AdaptiveRateLimiter(300, 15 * 60 * 1000)
};

// Utility function to pause execution with logging
function delay(ms) {
  console.log(`[${new Date().toISOString()}] Pausing for ${ms / 1000} seconds...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Enhanced MongoDB connection with better error handling
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
    
    // Setup database indexes and optimizations
    await setupDatabaseIndexes(db);
    
    return db;
  } catch (error) {
    console.error('[MongoDB] Connection error:', error);
    throw error;
  }
}

// Setup MongoDB indexes and optimizations
// Setup MongoDB indexes with error handling and checks
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
          // Try to get existing index info
          const existingIndexes = await db.collection(collection).listIndexes().toArray();
          const indexExists = existingIndexes.some(idx => {
            // Compare index key fields
            return Object.keys(idx.key).every(k => idx.key[k] === key[k]);
          });

          if (!indexExists) {
            // Create index only if it doesn't exist
            await db.collection(collection).createIndex(key, {
              background: true,
              ...options
            });
            console.log(`[MongoDB] Created index ${options.name} on ${collection}`);
          } else {
            console.log(`[MongoDB] Index already exists for ${JSON.stringify(key)} on ${collection}, skipping...`);
          }
        } catch (indexError) {
          // Log index creation error but continue with other indexes
          console.error(`[MongoDB] Error creating index ${options.name} on ${collection}:`, indexError);
          continue;
        }
      }
    }

    console.log('[MongoDB] Index setup completed');
  } catch (error) {
    console.error('[MongoDB] Index setup error:', error);
    // Don't throw the error, allow the application to continue
    console.log('[MongoDB] Continuing with existing indexes...');
  }
}

// Function to retrieve authenticated user's information
async function getAuthenticatedUser() {
  try {
    const user = await retryTwitterCall(
      () => twitterClient.v2.me({
        'user.fields': USER_FIELDS
      }),
      rateLimiters.userByUsername
    );
    console.log(`[Twitter] Authenticated as: @${user.data.username} (ID: ${user.data.id})`);
    return user.data;
  } catch (error) {
    console.error('[Twitter] Error fetching authenticated user info:', error);
    throw error;
  }
}

// Function to add or update an author in MongoDB
async function addOrUpdateAuthor(db, author) {
  try {
    const authorsCollection = db.collection('authors');
    let authorId = author.id;

    if (!authorId && author.username) {
      authorId = `temp_${uuidv4()}`;
      console.warn(
        `[MongoDB] Author @${author.username} missing ID. Assigned temporary ID: ${authorId}`
      );
    }

    if (!authorId) {
      throw new Error('Cannot add/update author without id or username');
    }

    await authorsCollection.updateOne(
      { id: authorId },
      {
        $set: {
          username: author.username,
          lastFetched: new Date(),
          lastMentionId: author.lastMentionId || null,
          ...author
        }
      },
      { upsert: true }
    );

    console.log(`[MongoDB] Updated author: @${author.username}`);
  } catch (error) {
    console.error('[MongoDB] Error updating author:', error);
    throw error;
  }
}

// Function to search for a user by username to fetch their ID
async function getUserByUsername(username) {
  try {
    // Remove '@' if present and clean the username
    const cleanUsername = username.startsWith('@') ? username.slice(1) : username;

    // Validate username format
    const regex = /^[A-Za-z0-9_]{1,15}$/;
    if (!regex.test(cleanUsername)) {
      console.warn(`[Twitter] Invalid username format: @${cleanUsername}`);
      return null;
    }

    const params = {
      'user.fields': USER_FIELDS
    };

    console.log(`[Twitter] Fetching user data for @${cleanUsername}`);

    const response = await retryTwitterCall(
      () => twitterClient.v2.userByUsername(cleanUsername, params),
      rateLimiters.userByUsername
    );

    if (response?.data) {
      console.log(`[Twitter] Successfully fetched user: @${response.data.username} (ID: ${response.data.id})`);
      return response.data;
    }

    console.warn(`[Twitter] No user found for username: @${cleanUsername}`);
    return null;

  } catch (error) {
    if (error.code === 50) {
      // User not found error
      console.warn(`[Twitter] User not found: @${username}`);
      return null;
    }
    
    console.error(`[Twitter] Error fetching user @${username}:`, error);
    throw error;
  }
}

// Enhanced Twitter API call handler with retry logic and adaptive rate limiting
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
        : Date.now() + Math.min(INITIAL_RETRY_DELAY * Math.pow(2, retryCount), MAX_RETRY_DELAY);

      const waitTime = Math.max(resetTime - Date.now(), INITIAL_RETRY_DELAY);
      console.error(
        `[Twitter] Rate limit exceeded. Attempt ${retryCount + 1}/${MAX_RETRIES}. Waiting ${waitTime / 1000}s...`
      );
      await delay(waitTime);
      return retryTwitterCall(apiCall, limiter, retryCount + 1);
    }

    console.error('[Twitter] API error:', error);
    throw error;
  }
}

// Enhanced home timeline fetching with error handling
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
  return await retryTwitterCall(
    () => twitterClient.v2.homeTimeline(params),
    rateLimiters.homeTimeline
  );
}

// Enhanced user tweets fetching
async function getUserTweets(authorId) {
  const params = {
    max_results: AUTHOR_TWEET_LIMIT,
    exclude: 'retweets',
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS
  };

  console.log(`[Twitter] Requesting tweets for user ID: ${authorId}`);
  return await retryTwitterCall(
    () => twitterClient.v2.userTimeline(authorId, params),
    rateLimiters.userTweets
  );
}

// Enhanced mentions search
async function searchAuthenticatedUserMentions(authUser) {
  const query = `@${authUser.username}`;
  
  const params = {
    query,
    max_results: 100,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS
  };

  console.log(`[Twitter] Searching mentions for @${authUser.username}`);
  return await retryTwitterCall(
    () => twitterClient.v2.search(params),
    rateLimiters.searchTweets
  );
}

// Optimized MongoDB operations with bulk writes
async function addTweetToMongoDB(db, tweets, includes) {
  const bulkOps = {
    tweets: [],
    authors: [],
    media: []
  };

  try {
    for (const tweet of tweets) {
      // Process media attachments
      if (tweet.attachments?.media_keys && includes?.media) {
        const mediaData = includes.media.filter(media =>
          tweet.attachments.media_keys.includes(media.media_key)
        );
        
        if (mediaData.length > 0) {
          tweet.mediaData = mediaData;
          bulkOps.media.push(...mediaData.map(media => ({
            updateOne: {
              filter: { media_key: media.media_key },
              update: { $set: media },
              upsert: true
            }
          })));
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

      // Add tweet
      bulkOps.tweets.push({
        updateOne: {
          filter: { id: tweet.id },
          update: { $set: tweet },
          upsert: true
        }
      });
    }

    // Execute bulk operations in parallel
    await Promise.all([
      bulkOps.tweets.length && db.collection('tweets').bulkWrite(bulkOps.tweets),
      bulkOps.authors.length && db.collection('authors').bulkWrite(bulkOps.authors),
      bulkOps.media.length && db.collection('media').bulkWrite(bulkOps.media)
    ]);

    console.log(`[MongoDB] Bulk operations completed successfully`);
  } catch (error) {
    console.error('[MongoDB] Bulk operation error:', error);
    throw error;
  }
}
// Enhanced mentions fetch cycle
async function startMentionsFetchCycle(db, authUser) {
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

      if (mentions.data?.data) {
        await addTweetToMongoDB(db, mentions.data.data, mentions.includes);
        console.log(`[Mentions] Processed ${mentions.data.data.length} new mentions`);
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
// Main function with enhanced error handling and logging
async function main() {
  let db;
  
  try {
    // Validate environment variables
    const requiredEnvVars = [
      'TWITTER_APP_TOKEN',
      'TWITTER_APP_SECRET',
      'TWITTER_ACCESS_TOKEN',
      'TWITTER_ACCESS_SECRET',
      'MONGODB_URI',
      'DB_NAME'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    // Connect to MongoDB
    db = await connectToMongoDB();
    const authUser = await getAuthenticatedUser();
    await addOrUpdateAuthor(db, authUser);

    // Start processes separately with different priorities
    startMainFetchCycle(db, authUser);
    
    // Start mentions fetch cycle
    startMentionsFetchCycle(db, authUser);

    // Delay start of background processes
    setTimeout(() => {
      startBackgroundProcesses(db);
    }, AUTHOR_UPDATE_INTERVAL);

  } catch (error) {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

// Separate background processes
async function startBackgroundProcesses(db) {
  while (true) {
    try {
      console.log('[Background] Starting background processes...');
      
      // Process a small batch of unknown authors
      await processUnknownAuthorsQueue(db, BATCH_SIZE);
      
      console.log(`[Background] Waiting ${AUTHOR_UPDATE_INTERVAL/1000}s before next update...`);
      await delay(AUTHOR_UPDATE_INTERVAL);
    } catch (error) {
      console.error('[Background] Error in background processes:', error);
      await delay(INITIAL_RETRY_DELAY);
    }
  }
}

// Modified unknown authors processing with batch size
async function processUnknownAuthorsQueue(db, batchSize = BATCH_SIZE) {
  const authorsCollection = db.collection('authors');
  const tempAuthors = await authorsCollection
    .find({ id: /^temp_/ })
    .limit(batchSize)
    .toArray();

  console.log(`[Background] Processing ${tempAuthors.length} temporary authors...`);

  for (const tempAuthor of tempAuthors) {
    try {
      if (!tempAuthor.username) {
        continue;
      }

      // Check if we already processed this author while processing the batch
      const currentAuthor = await authorsCollection.findOne({ id: tempAuthor.id });
      if (!currentAuthor || !currentAuthor.id.startsWith('temp_')) {
        continue;
      }

      const userData = await getUserByUsername(tempAuthor.username);
      if (userData) {
        await authorsCollection.updateOne(
          { id: tempAuthor.id },
          {
            $set: {
              id: userData.id,
              username: userData.username,
              lastFetched: new Date(),
              lastMentionId: tempAuthor.lastMentionId || null
            }
          }
        );
        console.log(`[Background] Updated temp author @${tempAuthor.username} with real ID: ${userData.id}`);
      }
    } catch (error) {
      if (error.code === 429) { // Rate limit error
        console.log('[Background] Rate limit hit, will retry in next batch');
        break; // Exit the loop and wait for next interval
      }
      console.error(`[Background] Error processing temp author @${tempAuthor.username}:`, error);
    }
  }
}

// Optimized main fetch cycle focusing on timeline
async function startMainFetchCycle(db, authUser) {
  const tweetsCollection = db.collection('tweets');

  while (true) {
    try {
      console.log('[Main] Starting timeline fetch...');
      
      const mostRecentTweet = await tweetsCollection
        .findOne({}, { sort: { created_at: -1 } });
      
      const timeline = await getHomeTimeline(mostRecentTweet?.id);
      
      if (timeline.data?.data) {
        await addTweetToMongoDB(db, timeline.data.data, timeline.includes);
        console.log(`[Main] Processed ${timeline.data.data.length} new tweets`);
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

// Handle process signals for graceful shutdown
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
    // Add cleanup logic here if needed
    console.log('[Process] Cleanup completed. Exiting...');
    process.exit(0);
  } catch (error) {
    console.error('[Process] Error during shutdown:', error);
    process.exit(1);
  }
}

// Start the scraper
main().catch(error => {
  console.error('[Fatal] Unhandled error:', error);
  process.exit(1);
});