import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { describeImage } from './vision.mjs';

// Configuration
dotenv.config();

// Database Service
class DatabaseService {
  constructor() {
    this.client = new MongoClient(process.env.MONGODB_URI, { ssl: true });
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(process.env.DB_NAME);
    console.log(`Connected to database: ${process.env.DB_NAME}`);
  }

  async close() {
    await this.client.close();
  }
}

// Tweet Service
class TweetService {
  constructor(db) {
    this.db = db;
  }

  async getPrioritizedTweets() {
    console.log('Fetching prioritized tweets...');
    const queries = [
      {
        filter: {
          text: { $regex: `@${process.env.TWITTER_USERNAME}`, $options: 'i' },
          author_id: { $ne: process.env.TWITTER_USER_ID },
          'processing_status.llm_context': { $ne: true }
        },
        sort: { engagement_score: -1, created_at: -1 }
      },
      {
        filter: {
          in_reply_to_user_id: process.env.TWITTER_USER_ID,
          author_id: { $ne: process.env.TWITTER_USER_ID },
          'processing_status.llm_context': { $ne: true }
        },
        sort: { engagement_score: -1, created_at: -1 }
      },
      {
        filter: {
          text: { $regex: `(#AI|#MachineLearning|@${process.env.TWITTER_USERNAME})`, $options: 'i' },
          author_id: { $ne: process.env.TWITTER_USER_ID },
          'processing_status.llm_context': { $ne: true }
        },
        sort: { engagement_score: -1, created_at: -1 }
      }
    ];

    const results = await Promise.all(
      queries.map(query => this.db.collection('tweets').find(query.filter).sort(query.sort).limit(50).toArray())
    );

    const [mentions, replies, related] = results;
    console.log(`Found ${mentions.length} mentions, ${replies.length} replies, and ${related.length} related tweets`);
    return [...mentions, ...replies, ...related];
  }

  async calculateEngagementScore(tweet) {
    const weights = { likes: 2, retweets: 1.5, replies: 1 };
    return (
      (tweet.like_count || 0) * weights.likes +
      (tweet.retweet_count || 0) * weights.retweets +
      (tweet.reply_count || 0) * weights.replies
    );
  }

  async enrichTweetsWithEngagement() {
    console.log('Enriching tweets with engagement scores...');
    const tweets = await this.db.collection('tweets').find({
      engagement_score: { $exists: false },
      like_count: { $exists: true },
      created_at: { $gte: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) }
    }).toArray();

    for (const tweet of tweets) {
      const score = await this.calculateEngagementScore(tweet);
      await this.db.collection('tweets').updateOne({ id: tweet.id }, { $set: { engagement_score: score } });
    }
  }
  async getConversationContext(tweetId, maxTweets = 5) {
    console.log(`Fetching conversation context for tweet ${tweetId}...`);
    const tweets = [];
    let currentTweet = await this.db.collection('tweets').findOne({ id: tweetId });

    while (currentTweet && tweets.length < maxTweets) {
      tweets.unshift(currentTweet); // Add the current tweet at the beginning
      if (!currentTweet.referenced_tweets?.length) break; // Stop if there are no referenced tweets
      currentTweet = await this.db.collection('tweets').findOne({
        id: currentTweet.referenced_tweets[0].id
      });
    }

    return this.trimConversation(tweets);
  }

  trimConversation(tweets) {
    if (tweets.length <= 5) return tweets;
    return [
      ...tweets.slice(0, 2), // First 2 tweets
      { type: 'separator', text: `... (${tweets.length - 5} tweets omitted) ...` },
      ...tweets.slice(-3) // Last 3 tweets
    ];
  }
}

// Author Service
// Author Service
class AuthorService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Fetch and classify target authors into prioritized, frequent, and new categories.
   */
  async getTargetAuthors() {
    console.log('Fetching target authors...');
    const alwaysReplyTo = ['HissMaxi', '_wibwob', '0xzerebro', 'aihegemonymemes'];

    const authors = await this.db.collection('authors').find().toArray();
    const frequentAuthors = await this.getFrequentAuthors();

    // Priority authors are those in alwaysReplyTo or with followers > 1000
    const prioritizedAuthors = authors.filter(author =>
      alwaysReplyTo.includes(author.username.toLowerCase()) || author.followers_count > 1000
    );

    // Categorize authors into priority, frequent, and new
    return {
      priority: prioritizedAuthors,
      frequent: authors.filter(a => frequentAuthors.includes(a.id)),
      new: authors.filter(a => !frequentAuthors.includes(a.id))
    };
  }

  /**
   * Identify authors with frequent interactions in the last 30 days.
   */
  async getFrequentAuthors() {
    console.log('Fetching frequent authors...');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get distinct author IDs from responses created within the last 30 days
    return this.db.collection('responses').distinct('author_id', { created_at: { $gte: thirtyDaysAgo } });
  }

  /**
   * Get a dynamic priority score for authors based on engagement metrics.
   */
  async calculateAuthorPriority(author) {
    const weights = {
      followers: 0.5,
      tweets: 0.3,
      interactions: 0.2
    };

    const interactions = await this.db.collection('responses').countDocuments({ author_id: author.id });
    return (
      (author.followers_count || 0) * weights.followers +
      (author.tweet_count || 0) * weights.tweets +
      interactions * weights.interactions
    );
  }

  /**
   * Prioritize authors dynamically and cache their scores.
   */
  async prioritizeAuthors() {
    console.log('Prioritizing authors...');
    const authors = await this.db.collection('authors').find().toArray();

    // Calculate priority scores for authors
    const scoredAuthors = await Promise.all(
      authors.map(async author => ({
        ...author,
        priorityScore: await this.calculateAuthorPriority(author)
      }))
    );

    // Sort by priorityScore in descending order
    return scoredAuthors.sort((a, b) => b.priorityScore - a.priorityScore);
  }
}


// Context Builder
class ResponseContextBuilder {
  constructor(db) {
    this.db = db;
    this.tweetService = new TweetService(db);
  }

  async buildContext(tweet, author) {
    console.log(`Building context for tweet ${tweet.id}`);

    if (!author) {
      console.warn(`Author not found for tweet ${tweet.id}. Proceeding with limited context.`);
      return this.formatPrompt({
        conversation: [],
        recentContext: '',
        visionContext: await this.getVisionContext(tweet),
        author: { username: 'Unknown', id: 'N/A' } // Fallback author details
      });
    }

    console.log(`Building context for tweet ${tweet.id} by @${author.username}`);
    const conversation = await this.tweetService.getConversationContext(tweet.id);
    const recentContext = await this.getRecentContext(tweet, author);
    const visionContext = await this.getVisionContext(tweet);

    await this.db.collection('tweets').updateOne(
      { id: tweet.id },
      { $set: { 'processing_status.llm_context': true, 'processing_status.llm_context_at': new Date() } }
    );

    return this.formatPrompt({
      conversation, recentContext, visionContext, author
    });
  }

  async getVisionContext(tweet) {
    if (!tweet.mediaData) return '';
    const mediaUrls = tweet.mediaData.filter(m => m.type === 'photo').map(m => m.url);
    return mediaUrls.length ? await this.processImages(mediaUrls) : '';
  }

  async processImages(urls) {
    const descriptions = [];
    for (const url of urls) {
      const cached = await this.db.collection('image_visions').findOne({ url });
      if (cached) {
        descriptions.push(cached.description);
      } else {
        try {
          const response = await describeImage(url);
          const description = response.choices[0].message.content;
          await this.db.collection('image_visions').insertOne({ url, description, created_at: new Date() });
          descriptions.push(description);
        } catch (error) {
          console.error(`Failed to process image: ${url}`, error);
        }
      }
    }
    return descriptions.join('\n');
  }

  async getRecentContext(tweet, author) {
    const recentResponses = await this.db.collection('responses')
      .find({ author_id: author.id, response: { $exists: true }, created_at: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
      .sort({ created_at: -1 })
      .limit(3)
      .toArray();

    return recentResponses.map(r => `Tweet: ${r.prompt}\nResponse: ${r.response}`).join('\n');
  }

  formatPrompt({ conversation, recentContext, visionContext, author }) {
    return [
      `Processing tweet from @${author.username}`,
      recentContext,
      'Conversation:',
      ...conversation.map(t => (t.type === 'separator' ? t.text : `${t.author_id === author.id ? '@' + author.username : 'Other'}: ${t.text}`)),
      visionContext
    ].filter(Boolean).join('\n\n');
  }
}

// Main Function
// Main Function
async function main() {
  const dbService = new DatabaseService();
  try {
    // Connect to the database
    await dbService.connect();

    // Initialize services
    const tweetService = new TweetService(dbService.db);
    const authorService = new AuthorService(dbService.db);
    const contextBuilder = new ResponseContextBuilder(dbService.db);

    // Step 1: Enrich tweets with engagement scores
    console.log('Step 1: Enriching tweets with engagement scores...');
    await tweetService.enrichTweetsWithEngagement();

    // Step 2: Fetch prioritized tweets
    console.log('Step 2: Fetching prioritized tweets...');
    const tweets = await tweetService.getPrioritizedTweets();
    console.log(`Total tweets fetched: ${tweets.length}`);

    // Step 3: Prioritize authors dynamically
    console.log('Step 3: Prioritizing authors...');
    const prioritizedAuthors = await authorService.prioritizeAuthors();
    console.log(`Top prioritized authors: ${prioritizedAuthors.slice(0, 5).map(a => `@${a.username}`)}`);

    // Step 4: Process tweets
    console.log('Step 4: Processing tweets...');
    for (const tweet of tweets) {
      const author = prioritizedAuthors.find(a => a.id === tweet.author_id);

      // Skip if author is not found or has low priority
      if (!author) {
        console.warn(`processing tweet ${tweet.id}: Author not found in priority list.`);
        //continue;
      }

      // Build context for the tweet
      const context = await contextBuilder.buildContext(tweet, author);

      // Save the processed response
      await dbService.db.collection('responses').updateOne(
        { tweet_id: tweet.id },
        {
          $set: {
            context,
            author_id: tweet?.author_id,
            processed_by: 'llm_context',
            processed_at: new Date()
          }
        },
        { upsert: true }
      );
      console.log(`Processed tweet ${tweet.id} by @${author?.username}`);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Close the database connection
    await dbService.close();
  }
}


// Start Loop
function startLoop() {
  setInterval(main, 5 * 60 * 1000);
  main();
}

startLoop();
