import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { postX, likeTweet } from './xpost.mjs'; // Import the postX function
import process from 'process';

// Load environment variables from .env file
dotenv.config();

// New configuration option to disable replies to authors you aren't following
const REPLY_TO_UNFOLLOWED = process.env.REPLY_TO_UNFOLLOWED === 'true';

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

let db;

// Function to get a list of accounts we are following
async function getFollowing() {
  const followingCollection = db.collection('following');
  return await followingCollection.find({}).toArray();
}

// Function to post tweets every 30 minutes
async function postGeneratedResponses() {
  try {
    const responsesCollection = db.collection('responses');

    // Get a list of authors we are following
    const following = await getFollowing();
    const followingIds = following.map(f => f.id);

    // Fetch all unposted responses
    let unpostedResponses = await responsesCollection.find({
      response: { $exists: true },
      posted: { $exists: false }
    }).toArray();

    if (unpostedResponses.length === 0) {
      console.log('No unposted responses found.');
      return;
    }

    const tweetsCollection = db.collection('tweets');

    // Enrich responses with author information
    for (const responseDoc of unpostedResponses) {
      const tweet = await tweetsCollection.findOne({ id: responseDoc.tweet_id });
      if (tweet && tweet.author_id) {
        responseDoc.author_id = tweet.author_id;
        responseDoc.isFollowing = followingIds.includes(tweet.author_id);
      } else {
        console.log(`Original tweet not found for response ID ${responseDoc._id}. Skipping.`);
        responseDoc.isFollowing = false; // Treat as not following if tweet not found
      }
    }

    // Optionally filter out responses to authors we aren't following
    if (!REPLY_TO_UNFOLLOWED) {
      unpostedResponses = unpostedResponses.filter(r => r.isFollowing);
    }

    // Prioritize responses to authors we are following
    unpostedResponses.sort((a, b) => b.isFollowing - a.isFollowing);

    for (const responseDoc of unpostedResponses) {
      const responseText = responseDoc.response;
      const tweetParams = {
        text: responseText,
      };

      try {
        // Post the tweet using postX function
        const tweetId = await postX(tweetParams, responseDoc.tweet_id);

        if (tweetId) {
          // Update the response in the database to mark it as posted
          await responsesCollection.updateOne(
            { _id: responseDoc._id },
            { $set: { posted: true, response_id: tweetId } }
          );
          console.log(`Successfully posted response with ID ${responseDoc._id} as tweet ID ${tweetId}`);
        }
      } catch (error) {
        console.error(`Error posting response with ID ${responseDoc._id}:`, error);
      }

      // Wait for 10 minutes before posting the next response
      const wait_time = ((Math.random() * 15) * 60 * 1000) + (15 * 60 * 1000); // 30 minutes
      console.log(`Waiting for ${Math.floor(wait_time / 1000 )} seconds before posting the next response...`);
      console.log(`Next response will be posted at ${(new Date(Date.now() + wait_time)).toLocaleTimeString()}`);
      await delay(wait_time);
      console.log('Done');
    }
  } catch (error) {
    console.error('Error posting generated responses:', error);
    process.exit(1);
  }
}


// Function to pause execution respecting rate limits
function delay(ms) {
  console.log(`${new Date().toLocaleTimeString()}: Pausing for ${ms / 1000} seconds...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {

  // Connect to MongoDB
  db = await connectToMongoDB();
  // Start posting generated responses
  await postGeneratedResponses();

}


async function loop() {
  while (true) {
    await main();
    await delay(1000 * 60 * 5); // 5 minutes
  }
}

loop().catch(console.error);