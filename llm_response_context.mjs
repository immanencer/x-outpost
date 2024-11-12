import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { response } from 'express';

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

// Function to gather context for responding to a tweet
async function getTweetResponseContext(tweetId, db, author) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');

  // Fetch the tweet
  const tweet = await tweetsCollection.findOne({ id: tweetId });
  if (!tweet) {
    console.error(`Tweet with ID ${tweetId} not found in database.`);
    return;
  }

  console.log(`Preparing response context for author: ${author.username}`);

  // Gather conversation context (referenced tweets)
  let conversation = [tweet];
  console.log(`Gathering conversation context for tweet ID: ${tweetId}`);
  let currentTweet = tweet;
  while (currentTweet.referenced_tweets && currentTweet.referenced_tweets.length > 0) {
    const referencedTweetId = currentTweet.referenced_tweets[0].id;
    currentTweet = await tweetsCollection.findOne({ id: referencedTweetId });
    if (currentTweet) {
      conversation.unshift(currentTweet);
      console.log(`Found referenced tweet: ${currentTweet.id} by author: ${currentTweet.author_id}`);
    } else {
      break;
    }
  }

  // Fetch recent tweets from the author around the same time
  if (!tweet.created_at) {  
    console.error(`Tweet with ID ${tweetId} does not have a created_at field.`);
    tweet.created_at = new Date().toISOString();
  }
  const tweetDate = new Date(tweet.created_at);
  const oneDay = 24 * 60 * 60 * 1000; // milliseconds in one day
  const startTime = new Date(tweetDate.getTime() - oneDay);
  const endTime = new Date(tweetDate.getTime() + oneDay);

  const recentTweets = await tweetsCollection.find({
    author_id: author.id,
    created_at: { $gte: startTime.toISOString(), $lte: endTime.toISOString() },
    id: { $ne: tweetId }
  }).toArray();

  console.log(`Found ${recentTweets.length} recent tweets from author ${author.username}`);

  // Prepare a list of relevant tweets
  const relevantTweets = conversation.map(t => ({
    author: t.author_id,
    text: t.text,
    created_at: t.created_at
  }));

  // Include recent tweets in the context
  const recentTweetsContext = recentTweets.map(t => ({
    author: t.author_id,
    text: t.text,
    created_at: t.created_at
  }));

  
  const authorPrompt = await authorsCollection.findOne({ id: tweet.author_id }).then(a => a.prompt);


  // Construct the prompt for the LLM
  const prompt = `You are responding to a tweet by ${author.username}. 

  ${authorPrompt}

Additionally, here are some of ${author.username}'s recent tweets:
${recentTweetsContext.map((t, index) => `${index + 1}. ${t.text}`).join('\n')}

Here is the conversation of relevant tweets so far:

${relevantTweets.map((t, index) => `${index + 1}. ${t.author}: ${t.text}`).join('\n')}

Now, write a tweet responding to the latest message from ${author.username}. Make sure your response is engaging, thoughtful, and relevant to the conversation.`;

  return prompt;
}

async function findLatestTweetMentioningOrReplyingToBob(db, authorId) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');
  const responsesCollection = db.collection('responses');

  const bob = await authorsCollection.findOne({ username: 'bobthesnek' });
  if (!bob) {
    console.error("Bob's user not found in the authors collection.");
    return null;
  }
  const bobId = bob.id;

  // Find tweet IDs that have already been responded to
  const respondedTweetIds = await responsesCollection
    .find({}, { projection: { tweet_id: 1 } })
    .toArray()
    .then(responses => responses.map(r => r.tweet_id));

  // Create a filter to find tweets mentioning '@bobthesnek' or replying to Bob
  const filter = {
    author_id: authorId,
    id: { $nin: respondedTweetIds }, // Exclude tweets already responded to
    $or: [
      { text: { $regex: '@bobthesnek', $options: 'i' } }, // Mentions @bobthesnek
      { in_reply_to_user_id: bobId } // Replies to Bob
    ]
  };

  // Query for the latest tweet matching the filter
  const latestTweet = await tweetsCollection
    .find(filter)
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();

  return latestTweet[0];
}

// Main execution function
(async () => {
  try {
    const db = await connectToMongoDB();
    const responsesCollection = db.collection('responses');
    responsesCollection.createIndex({ tweet_id: 1 }, { unique: true });
    const authorsCollection = db.collection('authors');

    const bobId = await authorsCollection.findOne({ username: 'bobthesnek' }).then(a => a.id);

    // List the known authors
    const authors = await authorsCollection.find().toArray();
    console.log('Known authors:', authors.map(a => `${a.username} (${a.id})`).join('\n'));

    for (const author of authors) {
      // find the latest tweet that mentions @bobthesnek per author, 
      // or is a reply to @bobthesne
      const xpost = await findLatestTweetMentioningOrReplyingToBob(db, author.id);

      if (!xpost) { 
        console.log(`No xpost found for author ${author.username}`);
        continue;
      }

      // Check if a response context already exists
      const existingResponse = await db.collection('responses').findOne({ tweet_id : xpost.id });
      if (existingResponse) {
        console.log(`Response context already exists for xpost ${xpost.id}`);
        continue;
      }

      const responseContext = await getTweetResponseContext(xpost.id, db, author);
      if (!responseContext) continue;

      console.log(`Response context for xpost ${xpost.id} (tweet ${xpost.id}):`, responseContext);

      // WRite the prompt to the database in a responses collection
      const responsesCollection = db.collection('responses');
      const response = {
        tweet_id: xpost.id,
        author_id: author.id,
        prompt: responseContext
      };

      // upsert the response
      await responsesCollection.updateOne({ tweet_id: xpost.id }, { $set: response }, { upsert: true });
    }

  } catch (error) {
    console.error('Error generating response context:', error);
    process.exit(1);
  }
})();
