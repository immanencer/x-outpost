import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';
import Bottleneck from 'bottleneck'; // Import Bottleneck

// Load environment variables from .env file
dotenv.config();

const TWEET_FIELDS = ['created_at', 'text', 'author_id', 'attachments', 'referenced_tweets'];

// Initialize Bottleneck with Twitter API rate limits
const limiter = new Bottleneck({
  reservoir: 900, // Number of tokens (requests) available
  reservoirRefreshAmount: 900, // Number of tokens to add at each refresh
  reservoirRefreshInterval: 15 * 60 * 1000, // Refresh every 15 minutes
  maxConcurrent: 1, // Maximum number of concurrent requests
  minTime: 5000, // Minimum time between requests (1 second)
});

// Create a wrapped Twitter client with rate limiting
const xClient = new TwitterApi({
  appKey: process.env.TWITTER_APP_TOKEN,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const defaultParams = {
  expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id'],
  'media.fields': ['url', 'preview_image_url'],
  'tweet.fields': TWEET_FIELDS,
};
const limitedTwitter = {
  homeTimeline: (params = defaultParams) => limiter.schedule(() => xClient.v2.homeTimeline(params)),
  tweets: (ids, params = defaultParams) => limiter.schedule(() => xClient.v2.tweets(ids, params)),
  user: (id) => limiter.schedule(() => xClient.v2.user(id)),
  userTimeline: (id, params = defaultParams) => limiter.schedule(() => xClient.v2.userTimeline(id, params)),
  singleTweet: (id, params = defaultParams) => limiter.schedule(() => xClient.v2.singleTweet(id, params)),
};

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

// Function to get the home timeline
async function getHomeTimeline(lastId) {
  const params = {
    max_results: 10,
    since_id: lastId,
    expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id'],
    'media.fields': ['url', 'preview_image_url'],
    'tweet.fields': TWEET_FIELDS,
  };

  if (lastId && typeof lastId === 'string') {
    params.since_id = lastId;
  }

  console.log('Requesting home timeline with params:', params);
  return await limitedTwitter.homeTimeline(params);
}

// Updated function to handle media properly
async function addTweetToMongoDB(db, tweet, includes) {
  const dbCollection = db.collection('tweets');
  dbCollection.createIndex({ id: 1 }, { unique: true });

  await dbCollection.updateOne({ id: tweet.id }, { $set: tweet }, { upsert: true });

  if (tweet.attachments && tweet.attachments.media_keys) {
    const mediaKeys = tweet.attachments.media_keys;
    if (includes && includes.media) {
      const mediaData = includes.media.filter(media => mediaKeys.includes(media.media_key));
      if (mediaData.length > 0) {
        console.log(`This tweet contains media! URLs: ${mediaData.map(m => m.url || m.preview_image_url).join(', ')}`);
      }
    }
  }

  console.log(`Upserted tweet: ${tweet.author_id} tweeted: ${tweet.text}`);
}

// Function to fill out tweets with missing author_id
async function fillMissingAuthorIds(db) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');

  // Find tweets with a missing author_id
  const tweetsMissingAuthorId = await tweetsCollection.find({ author_id: { $exists: false } }).toArray();

  console.log(`Found ${tweetsMissingAuthorId.length} tweets with missing author_id.`);

  for (const tweet of tweetsMissingAuthorId) {
    try {
      console.log(`Fetching author information for tweet ID: ${tweet.id}`);

      // Fetch the tweet from Twitter to get the author information
      const tweetResponse = await limitedTwitter.singleTweet(tweet.id);

      if (tweetResponse && tweetResponse.data) {
        const authorId = tweetResponse.data.author_id;
        if (authorId) {
          // Update the tweet in the database with the author_id
          await tweetsCollection.updateOne({ id: tweet.id }, { $set: { author_id: authorId } });

          // Check if the author is already in the authors collection
          const existingAuthor = await authorsCollection.findOne({ id: authorId });
          if (!existingAuthor) {
            // If the author is not in the authors collection, fetch and store the author data
            await researchAuthor(db, authorId);
          }

          console.log(`Updated tweet ID ${tweet.id} with author_id ${authorId}`);
        } else {
          console.error(`Author ID not found for tweet ID: ${tweet.id}`);
        }
      } else {
        console.error(`Failed to fetch tweet information for ID: ${tweet.id}`);
      }
    } catch (error) {
      console.error(`Error fetching or updating tweet with ID ${tweet.id}:`, error);
      if (error.code === 429) {
        const resetTime = error.rateLimit.reset;
        const currentTime = Math.floor(Date.now() / 1000);
        const waitSeconds = resetTime - currentTime;
        console.error(`Rate limit exceeded. Waiting for ${waitSeconds > 60 ? `${Math.floor(waitSeconds / 60)} minutes ` : `${waitSeconds} seconds `}before retrying.`);
        await delay(waitSeconds * 1000);
      } else {
        throw error;
      }
    }
  }

  console.log('Completed filling out tweets with missing author_id.');
}


// Function to research the author and add to MongoDB
async function researchAuthor(db, authorId) {
  const authorsCollection = db.collection('authors');
  if (!authorId) {
    console.error('Invalid author ID:', authorId);
    return;
  }
  console.log('Requesting user with author ID:', authorId);
  const author = await limitedTwitter.user(authorId);

  await delay(5000); // Delay for 5 seconds to avoid rate limits

  // Get a few recent tweets from the author excluding retweets
  const authorTweets = await limitedTwitter.userTimeline(authorId, {
    max_results: 10,
    exclude: 'retweets',
    'tweet.fields': TWEET_FIELDS,
  });

  const recentTweetIds = [];
  if (authorTweets.data && authorTweets.data.data) {
    for (const tweet of authorTweets.data.data) {
      await addTweetToMongoDB(db, tweet);
      recentTweetIds.push(tweet.id);
    }
  }

  const authorData = {
    id: author.data.id,
    name: author.data.name,
    username: author.data.username,
    recent_tweets: recentTweetIds,
    last_fetched_id: recentTweetIds[0] || null
  };

  await authorsCollection.updateOne({ id: authorId }, { $set: authorData }, { upsert: true });
  console.log(`Upserted author: ${author.data.username}`);
}

// Function to scrape tweets from known authors
async function scrapeKnownAuthors(db) {
  const authorsCollection = db.collection('authors');
  const authors = await authorsCollection.find({}).toArray();

  for (const author of authors) {
    let lastId = author.last_fetched_id || undefined;
    let moreTweets = true;

    while (moreTweets) {
      try {
        const params = {
          max_results: 10,
          exclude: 'retweets',
          'tweet.fields': TWEET_FIELDS,
        };

        if (lastId && typeof lastId === 'string') {
          params.since_id = lastId; // Only include since_id if it's valid
        }

        console.log('Requesting user timeline for author ID:', author.id, 'with params:', params);
        await delay(5000); // Delay for 5 seconds to avoid rate limits
        const authorTimeline = await limitedTwitter.userTimeline(author.id, params);

        if (!authorTimeline.data || !authorTimeline.data.data) {
          console.error(`No data found for author ${author.username}. Exiting.`);
          break;
        }

        for (const tweet of authorTimeline.data.data) {
          await addTweetToMongoDB(db, tweet);
          lastId = tweet.id; // Update lastId to the most recent tweet fetched
        }

        // Update the author's last fetched ID in the database
        await authorsCollection.updateOne({ id: author.id }, { $set: { last_fetched_id: lastId } });

        if (!authorTimeline.meta.next_token) {
          moreTweets = false;
        }

      } catch (error) {
        if (error.code === 429) {
          const resetTime = error.rateLimit?.reset || Date.now() / 1000 + 60;
          const currentTime = Math.floor(Date.now() / 1000);
          const waitSeconds = Math.max(resetTime - currentTime, 5); // Wait at least 60 seconds if resetTime is unavailable
          const waitMinutes = Math.floor(waitSeconds / 60);
          console.error(`Rate limit exceeded. Wait for ${waitMinutes > 0 ? `${waitMinutes} minutes` : `${waitSeconds} seconds`} before retrying.`);
          await delay(waitSeconds * 1000);
        } else {
          console.error('Unexpected error occurred:', error);
          process.exit(1);
        }
      }
    }

    console.log(`Completed scraping tweets for author: ${author.username}`);
  }
}

// Function to gather tweet data from xposts collection if missing
async function gatherMissingTweetsFromXPosts(db) {
  const xpostsCollection = db.collection('xposts');
  const tweetsCollection = db.collection('tweets');
  const xposts = await xpostsCollection.find({}).toArray();

  for (const post of xposts) {
    const tweetId = post.url.split('/').pop();
    if (!tweetId) {
      console.error('Invalid tweet ID extracted from URL:', post.url);
      continue;
    }

    const tweetExists = await tweetsCollection.findOne({ id: tweetId });
    if (!tweetExists) {
      try {
        console.log('Requesting single tweet with ID:', tweetId);
        await delay(1000); // Delay for 1 second to avoid rate limits
        const tweet = await limitedTwitter.singleTweet(tweetId);
        await addTweetToMongoDB(db, tweet.data);
      } catch (error) {
        console.error('Error fetching tweet or adding to MongoDB:', error);
      }
    }
  }

  console.log('Completed gathering missing tweets from xposts.');
}

// Function to pause execution respecting rate limits
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Search for unknown authors among the known tweets from the tweets collection
async function searchUnknownAuthors(db) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');

  const knownAuthors = await authorsCollection.find().toArray();
  const knownAuthorIds = knownAuthors.map(a => a.id);

  const unknownTweets = await tweetsCollection.find({ author_id: { $nin: knownAuthorIds } }).toArray();
  const unknownAuthors = [...new Set(unknownTweets.map(t => t.author_id))];

  console.log('Unknown authors found:', unknownAuthors);

  for (const authorId of unknownAuthors) {
    try {
      await researchAuthor(db, authorId);
      await delay(5000); // Delay for 5 seconds to avoid rate limits
    } catch (error) {
      console.error('Error researching author:', error);
      if (error.code === 429) {
        const resetTime = error.rateLimit.reset;
        const currentTime = Math.floor(Date.now() / 1000);
        const waitSeconds = resetTime - currentTime;
        console.error(`Rate limit exceeded. Wait for ${waitSeconds > 60 ? `${Math.floor(waitSeconds / 60)} minutes ` : `${waitSeconds} seconds `}before retrying.`);
      } else {
        throw error;
      }
    }
  }

  console.log('Completed searching for unknown authors.');
}

// Main execution function
(async () => {
  try {
    const db = await connectToMongoDB();
    const dbCollection = db.collection('tweets');

    // Get the timestamp of the most recent tweet
    const mostRecentTweet = await dbCollection.findOne({}, { sort: { created_at: -1 } });
    const lastFetchedTimestamp = mostRecentTweet ? new Date(mostRecentTweet.created_at).getTime() : 0;
    let lastId = mostRecentTweet ? mostRecentTweet.id : undefined;

    let moreTweets = true;
    while (moreTweets) {
      try {

        await delay(5000); // Delay for 5 seconds to avoid rate limits
        const jackTimeline = await getHomeTimeline(lastId);

        if (!jackTimeline.data || !jackTimeline.data.data) {
          console.error('No data found in the response. Exiting.');
          break;
        }

        // Iterate through tweets and add to MongoDB
        for (const tweet of jackTimeline.data.data) {
          await addTweetToMongoDB(db, tweet);
          lastId = tweet.id; // Update lastId to the most recent tweet fetched
        }

        if (!jackTimeline.meta.next_token) {
          moreTweets = false;
        }

      } catch (error) {
        if (error.code === 429) {
          const resetTime = error.rateLimit.reset;
          const currentTime = Math.floor(Date.now() / 1000);
          const waitSeconds = resetTime - currentTime;
          console.error(`Rate limit exceeded. Waiting for ${waitSeconds > 60 ? `${Math.floor(waitSeconds / 60)} minutes ` : `${waitSeconds} seconds `}before retrying.`);
        } else {
          throw error;
        }
      }
    }

    await delay(5000); // Delay for 5 seconds to avoid rate limits
    
    console.log('Filling out missing author IDs for tweets.');
    await fillMissingAuthorIds(db);


    await delay(5000); // Delay for 5 seconds to avoid rate limits

    // Search for unknown authors among the known tweets
    console.log('Searching for unknown authors among known tweets.');
    await searchUnknownAuthors(db);

    // Scrape tweets from known authors
    console.log('Scraping tweets from known authors.');
    await scrapeKnownAuthors(db);

    await delay(5000); // Delay for 5 seconds to avoid rate limits

    // Gather missing tweets from xposts
    console.log('Gathering missing tweets from xposts.');
    await gatherMissingTweetsFromXPosts(db);

    console.log('Storing tweets to MongoDB completed.');
  } catch (error) {
    console.error('Error initializing the scraper:', error);
    process.exit(1);
  }
})();
