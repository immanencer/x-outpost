import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import cron from 'node-cron';
import pLimit from 'p-limit';
import { describeImage } from './vision.mjs'; // Assuming ES Module

// --- Configuration Loading ---
dotenv.config();

const {
  MONGODB_URI,
  DB_NAME,
  TWITTER_USERNAME,
  TWITTER_USER_ID,
  ALWAYS_REPLY_TO,
  AUTHOR_PRIORITY_WEIGHT_FOLLOWERS,
  AUTHOR_PRIORITY_WEIGHT_TWEETS,
  AUTHOR_PRIORITY_WEIGHT_INTERACTIONS,
  ENGAGEMENT_WEIGHT_LIKES,
  ENGAGEMENT_WEIGHT_RETWEETS,
  ENGAGEMENT_WEIGHT_REPLIES,
  TWEET_FETCH_LIMIT,
  CONVERSATION_MAX_TWEETS,
  RECENT_CONTEXT_DAYS,
  RECENT_CONTEXT_LIMIT,
  ENRICHMENT_DAYS_AGO,
  IMAGE_PROCESSING_CONCURRENCY,
  CRON_SCHEDULE
} = process.env;

// Parse config values
const config = {
  dbUri: MONGODB_URI,
  dbName: DB_NAME,
  twitterUsername: TWITTER_USERNAME,
  twitterUserId: TWITTER_USER_ID,
  alwaysReplyToUsernames: ALWAYS_REPLY_TO ? ALWAYS_REPLY_TO.toLowerCase().split(',').map(u => u.trim()) : [],
  weights: {
    engagement: {
      likes: parseFloat(ENGAGEMENT_WEIGHT_LIKES || '2'),
      retweets: parseFloat(ENGAGEMENT_WEIGHT_RETWEETS || '1.5'),
      replies: parseFloat(ENGAGEMENT_WEIGHT_REPLIES || '1')
    },
    authorPriority: {
      followers: parseFloat(AUTHOR_PRIORITY_WEIGHT_FOLLOWERS || '0.5'),
      tweets: parseFloat(AUTHOR_PRIORITY_WEIGHT_TWEETS || '0.3'),
      interactions: parseFloat(AUTHOR_PRIORITY_WEIGHT_INTERACTIONS || '0.2')
    }
  },
  limits: {
    tweetFetch: parseInt(TWEET_FETCH_LIMIT || '50', 10),
    conversationMaxTweets: parseInt(CONVERSATION_MAX_TWEETS || '5', 10),
    recentContextDays: parseInt(RECENT_CONTEXT_DAYS || '7', 10),
    recentContextLimit: parseInt(RECENT_CONTEXT_LIMIT || '3', 10),
    enrichmentDaysAgo: parseInt(ENRICHMENT_DAYS_AGO || '1', 10),
    imageConcurrency: parseInt(IMAGE_PROCESSING_CONCURRENCY || '5', 10)
  },
  cronSchedule: CRON_SCHEDULE || '*/5 * * * *' // Default every 5 minutes
};

// --- Database Service ---
/**
 * Manages MongoDB connection.
 */
class DatabaseService {
  constructor(uri, dbName) {
    this.client = new MongoClient(uri, { ssl: true }); // Adjust options as needed
    this.dbName = dbName;
    this.db = null;
  }

  /**
   * Connects to the MongoDB database.
   * @throws {Error} If connection fails.
   */
  async connect() {
    try {
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      console.log(`Connected to database: ${this.dbName}`);
    } catch (error) {
      console.error("Database connection failed:", error);
      throw error; // Re-throw to prevent script from continuing without DB
    }
  }

  /**
   * Closes the MongoDB connection.
   */
  async close() {
    if (this.client) {
      await this.client.close();
      console.log("Database connection closed.");
    }
  }

  /**
   * Returns the database instance.
   * @returns {Db} MongoDB Db instance.
   * @throws {Error} If not connected.
   */
  getDb() {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return this.db;
  }
}

// --- Tweet Service ---
/**
 * Handles operations related to tweets.
 */
class TweetService {
  constructor(db) {
    this.db = db;
    this.tweetsCollection = db.collection('tweets');
  }

  /**
   * Fetches prioritized tweets based on mentions, replies, and keywords.
   * Only fetches tweets that haven't had context built yet.
   * @returns {Promise<Array>} Array of prioritized tweet documents.
   */
  async getPrioritizedTweets() {
    console.log('Fetching prioritized tweets...');
    const commonFilter = {
      author_id: { $ne: config.twitterUserId },
      'processing_status.llm_context': { $ne: true } // Only unprocessed
    };
    const commonSort = { engagement_score: -1, created_at: -1 };
    const limit = config.limits.tweetFetch;

    const queries = [
      // Mentions
      { filter: { ...commonFilter, text: { $regex: `@${config.twitterUsername}`, $options: 'i' } }, sort: commonSort },
      // Replies
      { filter: { ...commonFilter, in_reply_to_user_id: config.twitterUserId }, sort: commonSort },
      // Related (Keywords) - adjust regex as needed
      { filter: { ...commonFilter, text: { $regex: `(#AI|#MachineLearning|@${config.twitterUsername})`, $options: 'i' } }, sort: commonSort }
    ];

    try {
      const results = await Promise.all(
        queries.map(query =>
          this.tweetsCollection.find(query.filter).sort(query.sort).limit(limit).toArray()
        )
      );

      const [mentions, replies, related] = results;
      console.log(`Found unprocessed: ${mentions.length} mentions, ${replies.length} replies, ${related.length} related.`);

      // Combine and de-duplicate (using Set based on tweet ID)
      const uniqueTweets = Array.from(new Map(
        [...mentions, ...replies, ...related].map(tweet => [tweet.id, tweet])
      ).values());

      console.log(`Total unique prioritized tweets to process: ${uniqueTweets.length}`);
      return uniqueTweets;

    } catch (error) {
      console.error("Error fetching prioritized tweets:", error);
      return []; // Return empty array on error
    }
  }

  /**
   * Calculates engagement score for a single tweet.
   * @param {object} tweet - The tweet object.
   * @returns {number} The calculated engagement score.
   */
  calculateEngagementScore(tweet) {
    const { likes, retweets, replies } = config.weights.engagement;
    return (
      (tweet.public_metrics?.like_count || tweet.like_count || 0) * likes +
      (tweet.public_metrics?.retweet_count || tweet.retweet_count || 0) * retweets +
      (tweet.public_metrics?.reply_count || tweet.reply_count || 0) * replies
    );
  }

  /**
   * Finds recent tweets without an engagement_score and updates them in bulk.
   */
  async enrichTweetsWithEngagement() {
    console.log(`Enriching tweets from last ${config.limits.enrichmentDaysAgo} day(s) with engagement scores...`);
    const startDate = new Date(Date.now() - config.limits.enrichmentDaysAgo * 24 * 60 * 60 * 1000);

    try {
      const tweetsToUpdate = await this.tweetsCollection.find({
        engagement_score: { $exists: false },
        // Assuming metrics are nested or flat
        $or: [
            { 'public_metrics.like_count': { $exists: true } },
            { 'like_count': { $exists: true } }
        ],
        created_at: { $gte: startDate }
      }).toArray();

      if (tweetsToUpdate.length === 0) {
        console.log("No tweets found needing engagement score enrichment.");
        return;
      }

      console.log(`Found ${tweetsToUpdate.length} tweets to enrich.`);

      const bulkOps = tweetsToUpdate.map(tweet => ({
        updateOne: {
          filter: { _id: tweet._id }, // Use _id for efficiency
          update: { $set: { engagement_score: this.calculateEngagementScore(tweet) } }
        }
      }));

      if (bulkOps.length > 0) {
        const result = await this.tweetsCollection.bulkWrite(bulkOps, { ordered: false });
        console.log(`Bulk update result: ${result.modifiedCount} tweets enriched.`);
      }
    } catch (error) {
      console.error("Error enriching tweets with engagement scores:", error);
    }
  }

 /**
  * Fetches the conversation thread leading up to a given tweet ID.
  * @param {string} tweetId - The ID of the starting tweet.
  * @returns {Promise<Array>} Array of tweet objects in the conversation, trimmed.
  */
 async _getConversationContext(tweetId) {
    console.log(`  Fetching conversation context for tweet ${tweetId}...`);
    const tweets = [];
    let currentTweetId = tweetId;
    const visited = new Set(); // Prevent infinite loops in case of bad data

    try {
        while (currentTweetId && tweets.length < config.limits.conversationMaxTweets + 10 && !visited.has(currentTweetId)) { // Add buffer for trimming logic
            visited.add(currentTweetId);
            const tweet = await this.tweetsCollection.findOne({ id: currentTweetId });

            if (!tweet) break; // Stop if tweet not found

            tweets.unshift(tweet); // Add the current tweet at the beginning

            // Follow the 'replied_to' reference
            const repliedToRef = tweet.referenced_tweets?.find(ref => ref.type === 'replied_to');
            currentTweetId = repliedToRef ? repliedToRef.id : null;
        }
    } catch (error) {
        console.error(`  Error fetching conversation for tweet ${tweetId}:`, error);
        // Return whatever was fetched so far
    }

    return this._trimConversation(tweets);
 }


  /**
   * Trims a conversation array to keep the start and end, adding a separator.
   * @param {Array} tweets - Array of tweet objects.
   * @returns {Array} Trimmed array of tweets or separator objects.
   */
  _trimConversation(tweets) {
    const maxTweets = config.limits.conversationMaxTweets;
    if (tweets.length <= maxTweets) {
        return tweets;
    }
    const headCount = Math.ceil(maxTweets / 2); // e.g., 3 for max 5
    const tailCount = Math.floor(maxTweets / 2); // e.g., 2 for max 5
    return [
      ...tweets.slice(0, headCount),
      { type: 'separator', text: `... (${tweets.length - maxTweets} tweets omitted) ...` },
      ...tweets.slice(-tailCount)
    ];
  }
}


// --- Author Service ---
/**
 * Handles operations related to authors.
 */
class AuthorService {
  constructor(db) {
    this.db = db;
    this.authorsCollection = db.collection('authors');
    this.responsesCollection = db.collection('responses');
  }

  /**
   * Prioritizes authors using a MongoDB aggregation pipeline based on configured weights.
   * Fetches all authors and calculates scores efficiently in the database.
   * @returns {Promise<Array>} Sorted array of author documents with an added `priorityScore`.
   */
  async prioritizeAuthors() {
    console.log('Prioritizing authors using aggregation...');
    const { followers, tweets, interactions } = config.weights.authorPriority;

    const pipeline = [
      // 1. Lookup interactions (responses) for each author
      {
        $lookup: {
          from: 'responses', // The collection to join
          localField: 'id', // Field from the authors collection
          foreignField: 'author_id', // Field from the responses collection
          as: 'authorInteractions' // Output array field name
        }
      },
      // 2. Add fields for calculation
      {
        $addFields: {
          interactionCount: { $size: '$authorInteractions' },
          // Ensure numeric types and handle missing values
          followersCountNum: { $ifNull: ['$public_metrics.followers_count', '$followers_count', 0] },
          tweetCountNum: { $ifNull: ['$public_metrics.tweet_count', '$tweet_count', 0] }
        }
      },
      // 3. Calculate the priority score
      {
        $addFields: {
          priorityScore: {
            $add: [
              { $multiply: ['$followersCountNum', followers] },
              { $multiply: ['$tweetCountNum', tweets] },
              { $multiply: ['$interactionCount', interactions] }
            ]
          }
        }
      },
      // 4. Sort by the calculated score (descending)
      {
        $sort: { priorityScore: -1 }
      },
      // 5. Project to keep necessary fields and remove temporary ones
      {
        $project: {
          authorInteractions: 0, // Remove the joined data
          interactionCount: 0,
          followersCountNum: 0,
          tweetCountNum: 0
          // Keep all original author fields implicitly + priorityScore
        }
      }
    ];

    try {
      const prioritizedAuthors = await this.authorsCollection.aggregate(pipeline).toArray();
      console.log(`Successfully prioritized ${prioritizedAuthors.length} authors.`);
      if (prioritizedAuthors.length > 0) {
          console.log(`Top 3: ${prioritizedAuthors.slice(0, 3).map(a => `@${a.username} (${a.priorityScore.toFixed(2)})`).join(', ')}`);
      }
      return prioritizedAuthors;
    } catch (error) {
      console.error("Error prioritizing authors via aggregation:", error);
      return []; // Return empty array on error
    }
  }

  // Optional: Keep getTargetAuthors if classification (priority/frequent/new) is still needed
  // alongside the dynamic score. Modify it to use the results of prioritizeAuthors.
  /**
   * Classifies authors into prioritized (always reply), frequent, and others.
   * Note: This is a classification, distinct from the dynamic priority score.
   * @returns {Promise<object>} Object with 'priority', 'frequent', 'new' author arrays.
   */
  async getTargetAuthorsClassification() {
    console.log('Classifying target authors...');
    try {
        const authors = await this.authorsCollection.find().toArray();
        const frequentAuthorIds = await this._getFrequentAuthorIds();

        const classification = {
            priority: [], // Those in ALWAYS_REPLY_TO list
            frequent: [], // Interacted recently, not in priority
            new: [],      // Others
        };

        authors.forEach(author => {
            if (config.alwaysReplyToUsernames.includes(author.username.toLowerCase())) {
                classification.priority.push(author);
            } else if (frequentAuthorIds.has(author.id)) {
                classification.frequent.push(author);
            } else {
                classification.new.push(author);
            }
        });

        console.log(`Classified authors: ${classification.priority.length} priority, ${classification.frequent.length} frequent, ${classification.new.length} new.`);
        return classification;
    } catch (error) {
        console.error("Error classifying authors:", error);
        return { priority: [], frequent: [], new: [] };
    }
  }

  /**
   * Helper to get IDs of authors with recent interactions.
   * @returns {Promise<Set<string>>} Set of author IDs.
   */
  async _getFrequentAuthorIds() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    try {
      const ids = await this.responsesCollection.distinct('author_id', {
        created_at: { $gte: thirtyDaysAgo }
      });
      return new Set(ids);
    } catch (error) {
        console.error("Error fetching frequent author IDs:", error);
        return new Set();
    }
  }
}


// --- Context Builder ---
/**
 * Builds the context prompt for responding to a tweet.
 */
class ResponseContextBuilder {
  constructor(db) {
    this.db = db;
    this.tweetService = new TweetService(db); // Uses TweetService for conversation
    this.imageVisionsCollection = db.collection('image_visions');
    this.responsesCollection = db.collection('responses');
    this.imageProcessingLimit = pLimit(config.limits.imageConcurrency); // Concurrency limiter
  }

  /**
   * Builds the full context for a given tweet and author.
   * @param {object} tweet - The target tweet document.
   * @param {object | null} author - The author document (or null if not found).
   * @returns {Promise<string>} The formatted context prompt string.
   */
  async buildContext(tweet, author) {
    console.log(`Building context for tweet ${tweet.id}${author ? ` by @${author.username}` : ' (author unknown)'}`);

    // Use fallback details if author is missing
    const authorDetails = author || { username: 'Unknown', id: 'N/A', name: 'Unknown Author' };

    try {
      const [conversation, recentContext, visionContext] = await Promise.all([
        this.tweetService._getConversationContext(tweet.id), // Use internal method
        this._getRecentContext(authorDetails.id),
        this._getVisionContext(tweet)
      ]);

      // Mark the tweet as processed *after* context is successfully built
      await this.db.collection('tweets').updateOne(
        { id: tweet.id },
        { $set: { 'processing_status.llm_context': true, 'processing_status.llm_context_at': new Date() } }
      );

      return this._formatPrompt({
        conversation, recentContext, visionContext, author: authorDetails, tweet
      });

    } catch (error) {
      console.error(`Error building context for tweet ${tweet.id}:`, error);
      // Return a minimal context or error message
      return `Error building context for tweet ${tweet.id} from @${authorDetails.username}. Please analyze the tweet text directly: ${tweet.text}`;
    }
  }

  /**
   * Fetches vision descriptions for images in a tweet, using cache and parallel processing.
   * @param {object} tweet - The tweet document.
   * @returns {Promise<string>} Formatted string of image descriptions, or empty string.
   */
  async _getVisionContext(tweet) {
    const mediaUrls = tweet.mediaData?.filter(m => m.type === 'photo').map(m => m.url) || [];
    if (!mediaUrls.length) {
      return '';
    }
    console.log(`  Processing ${mediaUrls.length} image(s) for tweet ${tweet.id}...`);
    const descriptions = await this._processImagesWithConcurrency(mediaUrls);
    return descriptions.length > 0 ? `Image Descriptions:\n${descriptions.join('\n')}` : '';
  }

 /**
  * Processes multiple image URLs concurrently with rate limiting.
  * Checks cache before calling the vision API.
  * @param {string[]} urls - Array of image URLs.
  * @returns {Promise<string[]>} Array of image descriptions (or fallback text on error).
  */
 async _processImagesWithConcurrency(urls) {
    const descriptions = await Promise.all(
      urls.map(url => this.imageProcessingLimit(async () => {
        try {
          // 1. Check cache
          const cached = await this.imageVisionsCollection.findOne({ url });
          if (cached?.description) {
            console.log(`   Vision Cache HIT for: ${url.substring(0, 50)}...`);
            return cached.description;
          }

          // 2. Call Vision API
          console.log(`   Vision Cache MISS - Calling API for: ${url.substring(0, 50)}...`);
          const description = await describeImage(url); // External call

          // 3. Cache result (even if description is basic)
          await this.imageVisionsCollection.updateOne(
            { url },
            { $set: { url, description, created_at: new Date() } },
            { upsert: true }
          );
          return description;

        } catch (error) {
          console.error(`   Failed to process image: ${url}`, error);
          return "Image description unavailable due to an error."; // Fallback description
        }
      }))
    );
    return descriptions.filter(Boolean); // Filter out any potential null/empty results
 }


  /**
   * Fetches recent responses/interactions with a specific author.
   * @param {string} authorId - The ID of the author.
   * @returns {Promise<string>} Formatted string of recent interactions, or empty string.
   */
  async _getRecentContext(authorId) {
      if (!authorId || authorId === 'N/A') return ''; // No context if author unknown

      console.log(`  Fetching recent context for author ${authorId}...`);
      const lookbackDate = new Date(Date.now() - config.limits.recentContextDays * 24 * 60 * 60 * 1000);
      try {
          const recentResponses = await this.responsesCollection
              .find({
                  author_id: authorId,
                  response: { $exists: true, $ne: null, $ne: "" }, // Ensure response exists and is meaningful
                  created_at: { $gte: lookbackDate }
              })
              .sort({ created_at: -1 })
              .limit(config.limits.recentContextLimit)
              .project({ prompt: 1, response: 1, _id: 0 }) // Only fetch needed fields
              .toArray();

          if (recentResponses.length === 0) return '';

          const contextStr = recentResponses
              .map(r => `Previous Interaction:\nTweet Context: ${r.prompt}\nOur Response: ${r.response}`)
              .join('\n---\n');
          return `Recent Interactions with this user:\n${contextStr}`;
      } catch (error) {
          console.error(`  Error fetching recent context for author ${authorId}:`, error);
          return "Could not retrieve recent interaction context due to an error.";
      }
  }


  /**
   * Formats the collected context parts into a single prompt string.
   * @param {object} contextParts - Object containing conversation, recentContext, visionContext, author.
   * @returns {string} The final formatted prompt.
   */
  _formatPrompt({ conversation, recentContext, visionContext, author, tweet }) {
    const conversationText = conversation.map(t => {
        if (t.type === 'separator') return t.text;
        const speaker = t.author_id === config.twitterUserId ? `Me (${config.twitterUsername})`
                      : (t.author_id === author.id ? `@${author.username}` : `Other (${t.author_id})`);
        return `${speaker}: ${t.text}`;
    }).join('\n');

    // Construct the prompt, filtering out empty sections
    const promptParts = [
      `Analyze the following context involving @${author.username} (ID: ${author.id}, Name: ${author.name || 'N/A'}) and prepare a response.`,
      recentContext ? `--- Recent Interaction History ---\n${recentContext}` : null,
      conversationText ? `--- Current Conversation Thread --- \n${conversationText}` : null,
      visionContext ? `--- Image Analysis --- \n${visionContext}` : null,
      `--- Target Tweet to Respond To (@${author.username}) --- \n${conversation.find(t => t.id === tweet.id)?.text || tweet.text}` // Ensure target tweet is clear
    ];

    return promptParts.filter(Boolean).join('\n\n');
  }
}

// --- Main Application Logic ---
let isProcessing = false; // Simple lock to prevent overlap

/**
 * Main processing function, runs periodically.
 */
async function main() {
  if (isProcessing) {
    console.log("Skipping run: Previous run still in progress.");
    return;
  }
  isProcessing = true;
  console.log(`\n🚀 Starting processing run at ${new Date().toISOString()}...`);
  console.time("Total Run Time");

  const dbService = new DatabaseService(config.dbUri, config.dbName);

  try {
    await dbService.connect();
    const db = dbService.getDb();

    // Initialize services
    const tweetService = new TweetService(db);
    const authorService = new AuthorService(db);
    const contextBuilder = new ResponseContextBuilder(db);

    // Step 1: Enrich tweets (run concurrently with author prioritization)
    console.time("Step 1: Enrich Tweets");
    console.log("\n--- Step 1: Enriching Tweets ---");
    const enrichmentPromise = tweetService.enrichTweetsWithEngagement();

    // Step 2: Prioritize authors (run concurrently with enrichment)
    console.time("Step 2: Prioritize Authors");
    console.log("\n--- Step 2: Prioritizing Authors ---");
    const authorsPromise = authorService.prioritizeAuthors();

    // Wait for concurrent steps to finish
    const [_, prioritizedAuthors] = await Promise.all([enrichmentPromise, authorsPromise]);
    console.timeEnd("Step 1: Enrich Tweets");
    console.timeEnd("Step 2: Prioritize Authors");

    // Map authors by ID for quick lookup
    const authorMap = new Map(prioritizedAuthors.map(a => [a.id, a]));

    // Step 3: Fetch prioritized tweets
    console.time("Step 3: Fetch Prioritized Tweets");
    console.log("\n--- Step 3: Fetching Prioritized Tweets ---");
    const tweetsToProcess = await tweetService.getPrioritizedTweets();
    console.timeEnd("Step 3: Fetch Prioritized Tweets");

    if (tweetsToProcess.length === 0) {
        console.log("No tweets need processing in this run.");
        return; // Exit early if no tweets
    }

    // Step 4: Process tweets (Build context and save)
    console.time("Step 4: Process Tweets");
    console.log(`\n--- Step 4: Processing ${tweetsToProcess.length} Tweets ---`);
    let processedCount = 0;
    let failedCount = 0;

    for (const tweet of tweetsToProcess) {
      console.log(`\nProcessing tweet ${tweet.id} (Author ID: ${tweet.author_id})...`);
      const author = authorMap.get(tweet.author_id);

      if (!author) {
        console.warn(`  Author ${tweet.author_id} not found in prioritized list. Processing with limited author info.`);
        // Proceed, contextBuilder handles null author
      }

      try {
        console.time(`  Context Build Time Tweet ${tweet.id}`);
        const context = await contextBuilder.buildContext(tweet, author);
        console.timeEnd(`  Context Build Time Tweet ${tweet.id}`);

        // Save the processed context
        // Note: buildContext now marks the tweet as processed internally
        await db.collection('responses').updateOne(
          { tweet_id: tweet.id },
          {
            $set: {
              context: context, // The generated prompt/context
              author_id: tweet.author_id,
              author_username: author?.username || 'Unknown',
              processed_by: 'llm_context_builder_v2', // Version identifier
              processed_at: new Date(),
              // Add priority score if author found
              ...(author && { author_priority_score: author.priorityScore })
            },
            $setOnInsert: { // Fields to set only when inserting a new doc
                tweet_id: tweet.id,
                created_at: new Date()
            }
          },
          { upsert: true }
        );
        console.log(`  ✅ Successfully processed and saved context for tweet ${tweet.id}`);
        processedCount++;
      } catch (error) {
        console.error(`  ❌ Failed to process tweet ${tweet.id}:`, error);
        failedCount++;
        // Optionally mark tweet as failed?
        // await db.collection('tweets').updateOne({ id: tweet.id }, { $set: { 'processing_status.llm_context_error': error.message }});
      }
    }
    console.log(`\n--- Processing Summary ---`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Failed: ${failedCount}`);
    console.timeEnd("Step 4: Process Tweets");

  } catch (error) {
    console.error('\n🚨 CRITICAL ERROR in main execution:', error);
    // Consider adding monitoring/alerting here (e.g., Sentry)
  } finally {
    await dbService.close();
    isProcessing = false; // Release lock
    console.timeEnd("Total Run Time");
    console.log(`🏁 Processing run finished at ${new Date().toISOString()}. Waiting for next schedule: ${config.cronSchedule}`);
  }
}

// --- Scheduling ---
/**
 * Starts the processing loop using node-cron.
 */
function startLoop() {
  console.log(`Scheduling main process with cron schedule: ${config.cronSchedule}`);

  // Validate cron schedule
  if (!cron.validate(config.cronSchedule)) {
      console.error(`❌ Invalid CRON schedule: "${config.cronSchedule}". Please check your .env file. Using default "*/5 * * * *".`);
      config.cronSchedule = '*/5 * * * *';
  }

  // Schedule the main function
  cron.schedule(config.cronSchedule, main);

  // Optional: Run immediately on start
  console.log("Running initial process immediately...");
  main();
}

// --- Script Entry Point ---
// Check essential config
if (!config.dbUri || !config.dbName || !config.twitterUsername || !config.twitterUserId) {
    console.error("❌ Missing essential configuration in .env file (MONGODB_URI, DB_NAME, TWITTER_USERNAME, TWITTER_USER_ID). Exiting.");
    process.exit(1);
}

startLoop();

// --- TODO ---
// - Add comprehensive unit and integration tests (e.g., using Jest, mongodb-memory-server).
// - Create a detailed README.md explaining setup, configuration, and execution.
// - Implement more sophisticated error handling and retry logic for external API calls (vision, potentially Twitter API if used).
// - Consider adding schema validation (e.g., using Mongoose or Joi) for DB objects.
// - Add proper logging levels (info, warn, error) and potentially structured logging (JSON).
// - Implement monitoring and alerting for failures.