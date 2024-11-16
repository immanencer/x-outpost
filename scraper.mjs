import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';

// Load environment variables from .env file
dotenv.config();

const TWEET_FIELDS = ['created_at', 'text', 'author_id', 'attachments', 'referenced_tweets', 'in_reply_to_user_id', 'entities'];

// Create a Twitter client
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

// Function to retry Twitter API calls on rate limit
async function retryTwitterCall(apiCall, ...params) {
  while (true) {
    try {
      return await apiCall(...params);
    } catch (error) {
      if (error.code === 429) {
        const resetTime = error.rateLimit?.reset || Date.now() / 1000 + 60;
        const currentTime = Math.floor(Date.now() / 1000);
        const waitSeconds = Math.max(resetTime - currentTime, 5);
        console.error(`Rate limit exceeded. Waiting for ${waitSeconds} seconds before retrying.`);
        await delay(waitSeconds * 1000);

      } else {
        console.error('Unexpected error:', error, params);
        throw error;
      }
    }
  }
}

// Function to get the home timeline
async function getHomeTimeline(lastId) {
  const params = {
    max_results: 100,
    since_id: lastId,
    expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id', 'in_reply_to_user_id', 'entities.mentions.username'],
    'media.fields': ['url', 'preview_image_url'],
    'tweet.fields': TWEET_FIELDS,
  };

  console.log('Requesting home timeline with params:', params);
  return await retryTwitterCall(xClient.v2.homeTimeline.bind(xClient.v2), params);
}

// Function to add a tweet to MongoDB and discover new authors
async function addTweetToMongoDB(db, tweet, includes) {
  const dbCollection = db.collection('tweets');
  await dbCollection.createIndex({ id: 1 }, { unique: true });

  if (tweet.attachments?.media_keys && includes?.media) {
    const mediaData = includes.media.filter(media => tweet.attachments.media_keys.includes(media.media_key));
    if (mediaData.length > 0) {
      console.log(`Tweet contains media URLs: ${mediaData.map(m => m.url || m.preview_image_url).join(', ')}`);
      tweet.mediaData = mediaData;
    }
  }

  if (tweet.entities?.mentions) {
    const authorsCollection = db.collection('authors');
    for (const mention of tweet.entities.mentions) {
      const authorExists = await authorsCollection.findOne({ username: mention.username });
      if (!authorExists) {
        console.log(`Adding new author: ${mention.username}`);
        await authorsCollection.updateOne({ username: mention.username }, { $set: { username: mention.username } }, { upsert: true });
      }
    }
  }

  await dbCollection.updateOne({ id: tweet.id }, { $set: tweet }, { upsert: true });
  console.log(`Upserted tweet: ${tweet.author_id} tweeted: ${tweet.text}`);
}

let userByUsernameRateLimit = Date.now();
// Function to fill out tweets with missing author_id
async function fillMissingAuthorIds(db) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');
  const authorsMissingId = await authorsCollection.find({ id: { $exists: false } }).toArray();

  if (Date.now() < userByUsernameRateLimit) {
    console.log('Rate limit exceeded. Waiting for userByUsername rate limit to reset.');
    return;
  }

  try {
    // Find the author ID for each author
    for (const author of authorsMissingId) {
      console.log(`Researching author: ${author.username}`);
      const response = await xClient.v2.userByUsername(author.username);
      const authorId = response.data.id;
      await researchAuthor(db, authorId);
    }
  } catch (error) {
    console.error('Error fetching author:', error);
    if (error.code === 429) {
      userByUsernameRateLimit = Date.now() + (error.rateLimit.reset * 1000);
    }
  }
}


// Function to research the author and add to MongoDB
async function researchAuthor(db, authorId) {
  if (!authorId) {
    console.error('Invalid author ID:', authorId);
    return;
  }

  const authorsCollection = db.collection('authors');
  let author = await authorsCollection.findOne({ id: authorId });
  if (author) {
    console.log(`Author already exists: ${author.username}`);
  } else {
    console.log(`Researching author: ${authorId}`);
    author = (await retryTwitterCall(xClient.v2.user.bind(xClient.v2), authorId)).data;
  }

  await delay(15000);

  const authorTweets = await retryTwitterCall(xClient.v2.userTimeline.bind(xClient.v2), authorId, {
    max_results: 10,
    exclude: 'retweets',
    expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id', 'in_reply_to_user_id', 'entities.mentions.username'],
    'media.fields': ['url', 'preview_image_url'],
    'tweet.fields': TWEET_FIELDS,
  });

  const recentTweetIds = authorTweets.data?.data?.map(tweet => tweet.id) || [];
  for (const tweet of authorTweets.data?.data || []) {
    await addTweetToMongoDB(db, tweet, authorTweets.includes);
  }

  const authorData = {
    id: author.id,
    name: author.name,
    username: author.username,
    recent_tweets: recentTweetIds,
    last_fetched_id: recentTweetIds[0] || null,
  };

  await authorsCollection.updateOne({ id: authorId }, { $set: authorData }, { upsert: true });
  console.log(`Upserted author: ${author.username}`);
}

// Function to pause execution respecting rate limits
function delay(ms) {
  console.log(`${new Date().toLocaleTimeString()}: Pausing for ${ms / 1000} seconds...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FETCH_INTERVAL = 1000 * 60 * 15; // 15 minutes
// Function to fetch recent tweets for all known authors
async function fetchRecentTweetsForAuthors(db) {
  const authorsCollection = db.collection('authors');
  // Get 10 authors sorted by last fetched time

  const authors = await authorsCollection.find({}).sort({ lastFetched: 1 }).limit(10).toArray();

  console.log(`Fetching recent tweets for ${authors.length} authors...`);

  for (const author of authors) {

    try {
      console.log(`Fetching tweets for author: ${author.username} (ID: ${author.id})`);
      
      const params = {
        max_results: 10,
        exclude: 'retweets,replies',
        expansions: ['attachments.media_keys', 'referenced_tweets.id', 'author_id', 'in_reply_to_user_id', 'entities.mentions.username'],
        'media.fields': ['url', 'preview_image_url'],
        'tweet.fields': TWEET_FIELDS,
      };

      console.log('5 second delay before fetching tweets...');
      await delay(5000); // 1 second delay
      console.log('Requesting user timeline with params:', params);
      const tweetsResponse = await retryTwitterCall(
        xClient.v2.userTimeline.bind(xClient.v2),
        author.id,
        params
      );

      if (tweetsResponse.data?.data) {
        for (const tweet of tweetsResponse.data.data) {
          await addTweetToMongoDB(db, tweet, tweetsResponse.includes);
        }

        // Update author's last fetched timestamp and last fetched tweet ID
        await authorsCollection.updateOne(
          { id: author.id },
          { 
            $set: { 
              lastFetched: Date.now(),
              last_fetched_id: tweetsResponse.data.meta.newest_id || null
            } 
          },
          { upsert: true }
        );

        console.log(`Fetched and stored ${tweetsResponse.data.data.length} tweets for ${author.username}`);
      } else {
        console.log(`No new tweets found for ${author.username}`);
      }

      // Optional: Delay between API calls to respect rate limits
      await delay(1000); // 1 second delay
    } catch (error) {
      console.error(`Error fetching tweets for author ${author.username}:`, error);
      if (error.code === 429) {
        const resetTime = error.rateLimit?.reset || Date.now() / 1000 + 60;
        const currentTime = Math.floor(Date.now() / 1000);
        const waitSeconds = Math.max(resetTime - currentTime, 5);
        console.error(`Rate limit exceeded. Waiting for ${waitSeconds} seconds before retrying.`);
        await delay(waitSeconds * 1000);
      }
    }
  }

  console.log('Completed fetching tweets for all known authors.');
}


async function main() {
  try {
    const db = await connectToMongoDB();
    const dbCollection = db.collection('tweets');

    //    console.log('Connected to Twitter as user:', (await retryTwitterCall(xClient.v2.user.bind(xClient.v2), process.env.TWITTER_USER_ID)).data.username);

    const mostRecentTweet = await dbCollection.findOne({}, { sort: { created_at: -1 } });
    let lastId = mostRecentTweet?.id;

    while (true) {
      try {
        const timeline = await getHomeTimeline(lastId);

        if (!timeline.data?.data) {
          console.error('No data found in the response. Exiting.');
          break;
        }

        for (const tweet of timeline.data.data) {
          await addTweetToMongoDB(db, tweet, timeline.includes);
          lastId = tweet.id;
        }

        if (!timeline.meta.next_token) break;
      } catch (error) {
        console.error('Error fetching home timeline:', error);
      }
    }

    console.log('Fetching recent tweets for all known authors.');
    await fetchRecentTweetsForAuthors(db);

    console.log('Filling out missing author IDs for tweets.');
    await fillMissingAuthorIds(db);

    console.log('Done fetching tweets.');

  } catch (error) {
    console.error('Error initializing the scraper:', error);
    process.exit(1);
  }
}

main().catch(console.error);
