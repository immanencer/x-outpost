import dotenv from 'dotenv';
// Load environment variables from .env file
dotenv.config();

import { MongoClient } from 'mongodb';

import path from 'path';
import { fileURLToPath } from 'url';

import { describeImage } from './vision.mjs';

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

  // Fetch a few of our own tweets to use as context
  const ourTweets = await tweetsCollection.find({ author_id: author.id }).sort({ created_at: -1 }).limit(5).toArray();
  const authorPrompt = await authorsCollection.findOne({ id: author.id }).then(a => a.prompt);

  let visionResponse = '';
  
  if  (tweet.mediaData) {
    const mediaUrls = tweet.mediaData.filter(m => m.type === 'photo').map(m => m.url || m.preview_image_url);
    
    if (mediaUrls.length > 0) {
      console.log(`Tweet contains media URLs: ${mediaUrls.join(', ')}`);
      
      // Prepare the vision prompt
      visionResponse = 'The following images were found in the tweet:\n';
      mediaUrls.forEach(async (url) => {
        // Check the images collection to see if we've already described this image
        const described = await db.collection('image_visions').findOne({ url });
        if (!described) {
          // If not, describe the image using the vision model
          const response = await describeImage(url);
          const description = response.choices[0].message.content;
          console.log(`Describing image at ${url}: ${description}`);
          visionResponse += `${description}\n`;
          // Save the description to the database
          await db.collection('image_visions').insertOne({ url, description });
        } else {
          console.log(`Image at ${url} already described: ${described.description}`);
          visionResponse += `${described.description}\n`;
        }
      });
    }
  }

  // Construct the prompt for the LLM
  const prompt = `Here are some of your recent tweets:
  
  ${ourTweets.map((t, index) => `${index + 1}. ${t.text}`).join('\n')}
  
  You are responding to a tweet by ${author.username}, here is what you remember about them. 

  ${authorPrompt || 'Not much is known about them... yet.'}

Additionally, here are some of ${author.username}'s recent tweets:
${recentTweetsContext.map((t, index) => `${index + 1}. ${t.text}`).join('\n')}

Here is the conversation of relevant tweets so far:

${relevantTweets.map((t, index) => `${index + 1}. ${t.author}: ${t.text}`).join('\n')}

Now, write a tweet responding to this latest message from @${author.username}:

${tweet.text}

${visionResponse || ''}

Make sure your response is engaging, funny, and relevant to the conversation.
`;

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
  if (authorId === bobId) {
    console.error('Author ID is the same as Bob ID.');
    return null;
  }

  // Find tweet IDs that have already been responded to
  const respondedTweetIds = await responsesCollection
    .find({}, { projection: { tweet_id: 1 } })
    .toArray()
    .then(responses => responses.map(r => r.tweet_id));

  // Create a filter to find tweets mentioning '@bobthesnek' or replying to Bob
  const filter = {
    author_id: authorId, // Tweets by the author
    id: { $nin: respondedTweetIds }, // Exclude tweets already responded to
    $or: [
      { text: { $regex: '@bobthesnek', $options: 'i' } }, // Mentions @bobthesnek
      { text: { $regex: '🐍', $options: 'i' } }, // Emoji code for snake
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
async function main () {
  try {
    const db = await connectToMongoDB();
    const responsesCollection = db.collection('responses');
    responsesCollection.createIndex({ tweet_id: 1 }, { unique: true });
    const authorsCollection = db.collection('authors');

    // List the known authors
    const authors = await authorsCollection.find().toArray();
    console.log('Known authors:', authors.map(a => `${a.username} (${a.id})`).join('\n'));

    // Select two authors randomly who haven't been replied to recently
    const recentAuthors = await responsesCollection.distinct('author_id', { created_at: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } });
    const nonRecentAuthors = authors.filter(a => !recentAuthors.includes(a.id));
    const selectedAuthors = nonRecentAuthors.sort(() => 0.5 - Math.random()).slice(0, 2);

    // Hardcoded list of Twitter handles to always reply to
    const alwaysReplyToHandles = ['immanencer', 'theerebusai', '0xzerebro', 'chrypnotoad'];
    const alwaysReplyAuthors = authors.filter(a => alwaysReplyToHandles.includes(a.username));
    // select four random authors
    const randomAuthors = authors.sort(() => 0.5 - Math.random()).slice(0, 4);


    const targetAuthors = [...selectedAuthors, ...alwaysReplyAuthors, ...randomAuthors];


    for (const author of targetAuthors) {
      let xpost;
      if (alwaysReplyAuthors.includes(author) || randomAuthors.includes(author)) {
        // If this is an always-reply author, find their latest unresponded tweet
        // get the reponses to this author
        const responses = await responsesCollection.find({ author_id: author.id }).toArray();
        // Get the tweet ids of the responses
        const respondedTweetIds = responses.map(r => r.tweet_id);

        const latestTweet = await db.collection('tweets').findOne(
          { author_id: author.id },
          { id: { $nin: respondedTweetIds } },
          { sort: { created_at: -1 } }
        );
        if (!latestTweet) {
          console.log(`No recent tweets found for author ${author.username}. Skipping.`);
          continue;
        }
        console.log(`Found latest tweet for author ${author.username}: ${latestTweet.id}`);
        xpost = latestTweet;
      } else {
        // Otherwise, find the latest xpost for the author
        xpost = await findLatestTweetMentioningOrReplyingToBob(db, author.id);
      }

      if (!xpost) { 
        console.log(`No xpost found for author ${author.username}`);
        continue;
      }

      // filter tweets that were not in the past 24 hours
      const yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));
      if (xpost.created_at < yesterday.toISOString()) {
        console.log(`Xpost ${xpost.id} is stale. Skipping.`);
        continue;
      }

      if (xpost.entities?.cashtags && xpost.entities.cashtags.length > 0) {
        console.log(`Xpost ${xpost.id} contains cashtag. Skipping.`);
        continue;
      }

      console.log(`Found xpost for author ${author.username}: ${xpost.id}`);

      // Check if a response context already exists
      const existingResponse = await db.collection('responses').findOne({ tweet_id : xpost.id });
      if (existingResponse) {
        console.log(`Response context already exists for xpost ${xpost.id}`);
        continue;
      }

      const responseContext = await getTweetResponseContext(xpost.id, db, author);
      if (!responseContext) continue;

      console.log(`Response context for xpost ${xpost.id} (tweet ${xpost.id}):`, responseContext);

      // Write the prompt to the database in a responses collection
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
}

async function loop() {
  while (true) {
    await main();
    const niceDate = new Date().toLocaleString('en-US');
    console.log(`${niceDate} Waiting for next iteration...`); 
    await new Promise(resolve => setTimeout(resolve, 1000 * 60 * 5)); // 5 minutes
  }
}

loop().catch(console.error);
