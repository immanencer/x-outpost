import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { postX } from './xpost.mjs'; // Import the postX function
import process from 'process';

// Load environment variables
dotenv.config();

// Configurations
const REPLY_TO_UNFOLLOWED = process.env.REPLY_TO_UNFOLLOWED === 'true';
const POST_INTERVAL_MINUTES = parseInt(process.env.POST_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;

// Optional: TLS/SSL configurations if needed
// Adjust as appropriate for your environment (self-signed certs, CA file, etc.)
// For production, do NOT allow invalid certificates.
const mongoOptions = {
  // Uncomment or add your needed TLS options here:
  // tls: true,
  // tlsCAFile: '/path/to/rootCA.pem',
  // tlsAllowInvalidCertificates: true, // Use with caution!
};

let db;
let client;

// Delay utility
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff retry utility
async function retryOperation(operation, retries = 3, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < retries - 1) {
        await delay(delayMs * Math.pow(2, attempt)); // exponential backoff
      }
    }
  }
  throw lastError || new Error('All retry attempts failed');
}

// Connect to MongoDB with retry logic
async function connectToMongoDBWithRetry(retries = 5) {
  return retryOperation(async () => {
    client = new MongoClient(MONGODB_URI, mongoOptions);
    await client.connect();
    console.log('Connected to MongoDB successfully');
    return client.db(DB_NAME);
  }, retries, 2000); // try up to 5 times, base delay of 2s
}

// Fetch list of users we’re following
async function getFollowing() {
  return db.collection('following').find({}, { projection: { id: 1 } }).toArray();
}

// Post generated responses
async function postGeneratedResponses() {
  try {
    const responsesCollection = db.collection('responses');
    const tweetsCollection = db.collection('tweets');

    const followingIds = (await getFollowing()).map((f) => f.id);

    const responses = await responsesCollection
      .find({ response: { $exists: true }, posted: { $exists: false } })
      .toArray();

    if (responses.length === 0) {
      console.log('No unposted responses found.');
      return;
    }

    for (const response of responses) {
      try {
        const tweet = await tweetsCollection.findOne({ id: response.tweet_id });
        const isFollowing = tweet ? followingIds.includes(tweet.author_id) : false;

        if (!REPLY_TO_UNFOLLOWED && !isFollowing) {
          // Skip posting if the user is not followed
          continue;
        }

        const tweetId = await retryOperation(
          () => postX({ text: response.response }, response.tweet_id),
          3
        );

        await responsesCollection.updateOne(
          { _id: response._id },
          { $set: { posted: true, response_id: tweetId } }
        );

        console.log(`Posted response ID ${response._id} as tweet ID ${tweetId}`);
      } catch (error) {
        console.error(`Error posting response ID ${response._id}:`, error.message);
        await responsesCollection.updateOne(
          { _id: response._id },
          { $set: { posted: false, error: error.message } }
        );
      }

      // Wait before next post to avoid spamming
      console.log(`Waiting ${POST_INTERVAL_MINUTES / 1000} seconds before next post...`);
      await delay(POST_INTERVAL_MINUTES);
    }
  } catch (error) {
    console.error('Error in postGeneratedResponses():', error);
  }
}

// Graceful shutdown
async function handleShutdown(signal) {
  console.log(`Received ${signal}. Closing resources...`);
  try {
    if (client) {
      await client.close();
    }
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
}

// Main loop
async function mainLoop() {
  while (true) {
    try {
      await postGeneratedResponses();
    } catch (error) {
      // If we lose connection mid-loop, we attempt to reconnect
      console.error('Error in posting responses:', error);
      console.log('Attempting to reconnect to MongoDB...');
      try {
        db = await connectToMongoDBWithRetry();
      } catch (err) {
        console.error('Reconnection attempt failed:', err);
      }
    }

    // Wait 5 minutes before next iteration
    await delay(5 * 60 * 1000);
  }
}

// Start the script
async function main() {
  try {
    db = await connectToMongoDBWithRetry();
    await mainLoop();
  } catch (error) {
    console.error('Fatal error, shutting down:', error);
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

main().catch((error) => {
  console.error('Uncaught fatal error:', error);
  process.exit(1);
});
