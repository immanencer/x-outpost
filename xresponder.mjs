import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { postX, likeTweet } from './xpost.mjs'; // Import the postX function
import process from 'process';

import { SnakeFinder } from './search/findSnakes.mjs';

// Load environment variables from .env file
dotenv.config();

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

let db;

// Function to post tweets every 30 minutes
async function postGeneratedResponses() {
  try {
    const responsesCollection = db.collection('responses');

    // Fetch all responses that haven't been posted yet
    const unpostedResponses = await responsesCollection.find({
      response: { $exists: true },
      posted: { $exists: false }
    }).toArray();

    if (unpostedResponses.length === 0) {
      console.log('No unposted responses found.');
      return;
    }

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

      // Wait for 30 minutes before posting the next response
      const wait_time = ((Math.random() * 5) * 60 * 100) + (1 * 60 * 100); // 30 minutes
      console.log(`Waiting for ${Math.floor(wait_time / 1000 )} seconds before posting the next response...`);
      await delay(wait_time);
      console.log('Done');
    }
  } catch (error) {
    console.error('Error posting generated responses:', error);
    process.exit(1);
  }
}

// Function to delay execution
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {

  // Connect to MongoDB
  db = await connectToMongoDB();
  // Start posting generated responses
  await postGeneratedResponses();

}


main().catch(console.error);