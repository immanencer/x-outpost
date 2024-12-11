import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { describeImage } from './vision.mjs';

// Configuration
dotenv.config();

class DatabaseService {
  constructor() {
    this.client = new MongoClient(process.env.MONGODB_URI, { ssl: true });
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(process.env.DB_NAME);
    console.log(`Connected to database: ${process.env.DB_NAME}`);
    await this.createIndexes();
  }

  async createIndexes() {
    console.log('Creating/verifying database indexes...');
    await this.db.collection('responses').createIndex({ tweet_id: 1 }, { unique: true });
    await this.db.collection('responses').createIndex({ processed_by: 1, processed_at: 1 });
    await this.db.collection('image_visions').createIndex({ url: 1 }, { unique: true });
    console.log('Database indexes verified');
  }

  async close() {
    await this.client.close();
  }
}

class TweetService {
  constructor(db) {
    this.db = db;
  }

  async getPrioritizedTweets() {
    console.log('Fetching prioritized tweets...');
    const mentions = await this.db.collection('tweets').find({
      text: { $regex: `@${process.env.TWITTER_USERNAME}`, $options: 'i' },
      author_id: { $ne: process.env.TWITTER_USER_ID },
      'processing_status.llm_context': { $ne: true }
    }).sort({ created_at: -1 }).toArray();

    const replies = await this.db.collection('tweets').find({
      in_reply_to_user_id: process.env.TWITTER_USER_ID,
      author_id: { $ne: process.env.TWITTER_USER_ID },
      'processing_status.llm_context': { $ne: true }
    }).sort({ created_at: -1 }).toArray();

    console.log(`Found ${mentions.length} mentions and ${replies.length} replies to process`);
    return [...mentions, ...replies];
  }

  async getConversationContext(tweetId, maxTweets = 5) {
    const tweets = [];
    let currentTweet = await this.db.collection('tweets').findOne({ id: tweetId });
    
    while (currentTweet && tweets.length < maxTweets) {
      tweets.unshift(currentTweet);
      if (!currentTweet.referenced_tweets?.length) break;
      currentTweet = await this.db.collection('tweets').findOne({ 
        id: currentTweet.referenced_tweets[0].id 
      });
    }

    return this.trimConversation(tweets);
  }

  trimConversation(tweets) {
    if (tweets.length <= 5) return tweets;
    return [
      ...tweets.slice(0, 2),
      { type: 'separator', text: `... (${tweets.length - 5} tweets omitted) ...` },
      ...tweets.slice(-3)
    ];
  }
}

class AuthorService {
  constructor(db) {
    this.db = db;
  }

  async getTargetAuthors() {
    const alwaysReplyTo = ['theerebusai', '0xzerebro', 'aihegemonymemes'];
    const authors = await this.db.collection('authors').find().toArray();
    const frequentAuthors = await this.getFrequentAuthors();

    return {
      priority: authors.filter(a => alwaysReplyTo.includes(a.username.toLowerCase())),
      frequent: authors.filter(a => frequentAuthors.includes(a.id)),
      new: authors.filter(a => !frequentAuthors.includes(a.id))
    };
  }

  async getFrequentAuthors() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.db.collection('responses').distinct('author_id', {
      created_at: { $gte: thirtyDaysAgo }
    });
  }
}

class ResponseContextBuilder {
  constructor(db) {
    this.db = db;
    this.tweetService = new TweetService(db);
  }

  async buildContext(tweet, author) {
    console.log(`Building context for tweet ${tweet.id} by @${author.username}`);
    const conversation = await this.tweetService.getConversationContext(tweet.id);
    console.log(`Found ${conversation.length} tweets in conversation`);

    const recentContext = await this.getRecentContext(tweet, author);
    const visionContext = await this.getVisionContext(tweet);
    
    // Mark tweet as processed by this module
    await this.db.collection('tweets').updateOne(
      { id: tweet.id },
      { 
        $set: { 
          'processing_status.llm_context': true,
          'processing_status.llm_context_at': new Date()
        }
      }
    );

    return this.formatPrompt({
      conversation,
      recentContext,
      visionContext,
      author
    });
  }

  async getVisionContext(tweet) {
    if (!tweet.mediaData) return '';
    const mediaUrls = tweet.mediaData.filter(m => m.type === 'photo').map(m => m.url);
    if (!mediaUrls.length) return '';

    return await this.processImages(mediaUrls);
  }

  async processImages(urls) {
    console.log(`Processing ${urls.length} images...`);
    const descriptions = [];
    for (const url of urls) {
      console.log(`Processing image: ${url}`);
      const cached = await this.db.collection('image_visions').findOne({ url });
      if (cached) {
        console.log('Using cached image description');
        descriptions.push(cached.description);
        continue;
      }

      try {
        const response = await describeImage(url);
        const description = response.choices[0].message.content;
        await this.db.collection('image_visions').insertOne({ 
          url, 
          description,
          created_at: new Date()
        });
        descriptions.push(description);
        console.log('Image processed and cached successfully');
      } catch (error) {
        console.error(`Failed to process image: ${url}`, error);
      }
    }

    return descriptions.length ? 'Images in tweet:\n' + descriptions.join('\n') : '';
  }

  async getRecentContext(tweet, author) {
    console.log(`Getting recent context for author @${author.username}`);
    
    // Get recent interactions
    const recentResponses = await this.db.collection('responses')
      .find({ 
        author_id: author.id,
        response: { $exists: true },
        created_at: { 
          $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
        }
      })
      .sort({ created_at: -1 })
      .limit(3)
      .toArray();

    if (recentResponses.length === 0) {
      console.log('No recent interactions found');
      return '';
    }

    console.log(`Found ${recentResponses.length} recent interactions`);
    
    // Format recent interactions
    const recentContext = recentResponses.map(r => 
      `Previous interaction on ${new Date(r.created_at).toISOString()}:\n` +
      `Tweet: ${r.prompt}\n` +
      `Response: ${r.response}\n`
    ).join('\n');

    return recentContext ? 'Recent interactions:\n' + recentContext : '';
  }

  formatPrompt({ conversation, recentContext, visionContext, author }) {
    const parts = [
      `Processing tweet from @${author.username}`,
      recentContext,
      'Conversation:',
      ...conversation.map(t => 
        t.type === 'separator' ? t.text : 
        `${t.author_id === author.id ? '@' + author.username : 'Other'}: ${t.text}`
      ),
      visionContext
    ].filter(Boolean);

    return parts.join('\n\n');
  }
}

async function main() {
  const db = new DatabaseService();
  try {
    await db.connect();
    console.log('Starting processing cycle...');
    
    const tweetService = new TweetService(db.db);
    const authorService = new AuthorService(db.db);
    const contextBuilder = new ResponseContextBuilder(db.db);

    const tweets = await tweetService.getPrioritizedTweets();
    console.log(`Processing ${tweets.length} tweets`);

    for (const tweet of tweets) {
      try {
        const author = await db.db.collection('authors').findOne({ id: tweet.author_id });
        if (!author) {
          console.log(`Author not found for tweet ${tweet.id}, skipping`);
          continue;
        }

        console.log(`Processing tweet ${tweet.id} by @${author.username}`);
        const context = await contextBuilder.buildContext(tweet, author);
        
        await db.db.collection('responses').updateOne(
          { tweet_id: tweet.id },
          { 
            $set: { 
              context,
              processed_by: 'llm_context',
              processed_at: new Date()
            }
          },
          { upsert: true }
        );
        
        console.log(`Successfully processed tweet ${tweet.id}`);
      } catch (error) {
        console.error(`Error processing tweet ${tweet.id}:`, error);
      }
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await db.close();
    console.log('Processing cycle completed');
  }
}

function startLoop() {
  setInterval(main, 5 * 60 * 1000);
  main();
}

startLoop();
