import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';

// Load environment variables from .env file
dotenv.config();

const xClient = new TwitterApi({
  appKey: process.env.TWITTER_APP_TOKEN,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

async function addTweetToMongoDB(db, tweet) {
  const dbCollection = db.collection('tweets');

  // Upsert the tweet to MongoDB
  await dbCollection.updateOne({ id: tweet.id }, { $set: tweet }, { upsert: true });

  // Check if the tweet has referenced tweets
  if (tweet.referenced_tweets) {
    const referencedTweets = await xClient.v2.tweets(tweet.referenced_tweets.map(rt => rt.id));
    for (const referencedTweet of referencedTweets.data) {
      await addTweetToMongoDB(db, referencedTweet);
    }
  }

  // Check if the tweet has media
  if (tweet.attachments && tweet.attachments.media_keys) {
    const medias = await xClient.v2.media(tweet.attachments.media_keys);
    console.log('This tweet contains media! URLs:', medias.map(m => m.url));
  }

  // Check if the author exists in the collection
  const authorExists = await dbCollection.findOne({ id: tweet.author_id, author: true });
  if (!authorExists) {
    const author = await xClient.v2.user(tweet.author_id);
    await dbCollection.updateOne({ id: author.id, author: true }, { $set: author }, { upsert: true });
  }

  console.log('Upserted tweet:', `${tweet.author_id} tweeted: ${tweet.text}`);
}

// Function to pause execution respecting rate limits
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        const jackTimeline = await xClient.v2.homeTimeline({
          max_results: 10,
          expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id'],
          'media.fields': ['url'],
          'tweet.fields': ['created_at'],
          since_id: lastId // Specify the last tweet ID to avoid fetching duplicates
        });

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
          console.error(`Rate limit exceeded. Waiting for ${waitSeconds} seconds before retrying.`);
          await delay(waitSeconds * 1000);
        } else {
          throw error;
        }
      }
    }

    console.log('Storing tweets to MongoDB completed.');
  } catch (error) {
    console.error('Error initializing the scraper:', error);
  }
})();
