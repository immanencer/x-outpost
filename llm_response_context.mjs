import dotenv from 'dotenv';
// Load environment variables from .env file
dotenv.config();

import { MongoClient } from 'mongodb';

import path from 'path';
import { fileURLToPath } from 'url';

import { describeImage } from './vision.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const client = new MongoClient(process.env.MONGODB_URI);

// Function to connect to MongoDB
async function connectToMongoDB() {
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

  // Trim the conversation to include only the first two tweets and the most recent three tweets
  let trimmedConversation = [];
  if (conversation.length > 5) {
    trimmedConversation = [
      ...conversation.slice(0, 2),
      { type: 'separator', text: `... (${conversation.length - 5} tweets omitted) ...` },
      ...conversation.slice(-3),
    ];
  } else {
    trimmedConversation = conversation;
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
  const relevantTweets = trimmedConversation.map(t =>
    t.type === 'separator' ? t : {
      author: t.author_id,
      text: t.text,
      created_at: t.created_at
    }
  );

  // Include recent tweets in the context
  const recentTweetsContext = recentTweets.map(t => ({
    author: t.author_id,
    text: t.text,
    created_at: t.created_at
  }));

  // Fetch a few of our own tweets to use as context
  const ourTweets = await tweetsCollection.find({ author_id: process.env.TWITTER_USER_ID }).sort({ created_at: -1 }).limit(5).toArray();
  const authorPrompt = await authorsCollection.findOne({ id: author.id }).then(a => a.prompt);

  let visionResponse = '';
  
  if (tweet.mediaData) {
    const mediaUrls = tweet.mediaData.filter(m => m.type === 'photo').map(m => m.url || m.preview_image_url);
    
    if (mediaUrls.length > 0) {
      console.log(`Tweet contains media URLs: ${mediaUrls.join(', ')}`);
      
      // Prepare the vision prompt
      visionResponse = 'The following images were found in the tweet:\n';
      for (const url of mediaUrls) {
        try {
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
        } catch (error) {
          console.error(`Error processing image at ${url}:`, error);
        }
      }
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

${relevantTweets.map((t, index) => t.type === 'separator' ? t.text : `${index + 1}. ${t.author}: ${t.text}`).join('\n')}

Now, write a tweet responding to this latest message from @${author.username}:

${tweet.text}

${visionResponse || ''}

Make sure your response is engaging, funny, and relevant to the conversation.
`;

  return prompt;
}


async function findLatestTweetMentioningOrReplyingToBob(db, authorId, allPostAuthors = []) {
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
      { author_id: { $in: allPostAuthors } }, // Added comma and corrected 'authorId' to 'author_id'
      { text: { $regex: 'bob', $options: 'i' } }, // Mentions @bobthesnek
      { text: { $regex: '@bobthesnek', $options: 'i' } }, // Mentions @bobthesnek
      { text: { $regex: '🐍', $options: 'i' } }, // Emoji code for snake
      { text: { $regex: 'snake', $options: 'i' } }, // reply to snake
      { in_reply_to_user_id: bobId } // Replies to Bob
    ]
  };

  // Query for the latest tweet matching the filter
  const latestTweet = await tweetsCollection
    .find(filter)
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();

  if (latestTweet.length === 0) {
    console.log(`No tweets found for author ${authorId} mentioning or replying to Bob.`);
    return null;
  }

  if (latestTweet[0].text.startsWith(`RT: @${process.env.TWITTER_USERNAME}`)) {
    console.log(`Skipping retweet of own tweet ${latestTweet[0].id}`);
    return null;
  }

  return latestTweet[0];
}

async function findMissingHandle(authorId, tweet, db) {
  const authorsCollection = db.collection('authors');
  let username = null;

  // Check if the tweet is a retweet
  if (tweet.text.startsWith('RT @')) {
    const match = tweet.text.match(/^RT @(\w+):/);
    if (match) {
      username = match[1];
    }
  }

  // If username is still null, check referenced tweets
  if (!username && tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
    for (const ref of tweet.referenced_tweets) {
      const refTweet = await db.collection('tweets').findOne({ id: ref.id });
      if (refTweet && refTweet.author_id) {
        const refAuthor = await authorsCollection.findOne({ id: refTweet.author_id });
        if (refAuthor && refAuthor.username) {
          username = refAuthor.username;
          break;
        }
      }
    }
  }

  // If username is still null, try to extract from text
  if (!username) {
    const match = tweet.text.match(/@(\w+)/);
    if (match) {
      username = match[1];
    }
  }

  // Update the author in the authors collection
  if (username) {
    await authorsCollection.updateOne(
      { id: authorId },
      { $set: { username } },
      { upsert: true }
    );
    console.log(`Updated author ${authorId} with username ${username}`);
  }

  return username;
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
    console.log(`${authors.length} authors found.`);

    // Retrieve tweets to prioritize
    const tweetsCollection = db.collection('tweets');
    const ourMentions = await tweetsCollection.find({ text: { $regex: `@${process.env.TWITTER_USERNAME}`, $options: 'i' }, author_id: { $ne: process.env.TWITTER_USER_ID }, author_id: { $ne: process.env.TWITTER_USER_ID } }).sort({ created_at: -1 }).toArray();
    const ourTweetsReplies = await tweetsCollection.find({ in_reply_to_user_id: process.env.TWITTER_USER_ID, author_id: { $ne: process.env.TWITTER_USER_ID } }).sort({ created_at: -1 }).toArray();

    // Combine prioritized tweets
    const prioritizedTweets = [...ourMentions, ...ourTweetsReplies];

    // Set for uniqueness of tweets
    const tweetSet = new Set();
    prioritizedTweets.forEach(t => tweetSet.add(t.id));

    for (const tweet of prioritizedTweets) {
      let author = await authorsCollection.findOne({ id: tweet.author_id });
      if (!author || !author.username) {
        const username = await findMissingHandle(tweet.author_id, tweet, db);
        if (username) {
          author = { id: tweet.author_id, username };
        } else {
          console.error(`Could not find username for author ${tweet.author_id}`);
          continue;
        }
      }

      // Skip already processed tweets
      const existingResponse = await db.collection('responses').findOne({ tweet_id : tweet.id });
      if (existingResponse) {
        console.log(`Response context already exists for tweet ${tweet.id}`);
        continue;
      }

      const responseContext = await getTweetResponseContext(tweet.id, db, author);
      if (!responseContext) continue;

      console.log(`Response context for tweet ${tweet.id} by author ${author.username}:`, responseContext);

      // Write the prompt to the database in a responses collection
      const response = {
        tweet_id: tweet.id,
        author_id: author.id,
        prompt: responseContext
      };

      // upsert the response
      await responsesCollection.updateOne({ tweet_id: tweet.id }, { $set: response }, { upsert: true });
    }

    // Process tweets from known authors
    const alwaysReplyToHandles = ['immanencer', 'theerebusai', '0xzerebro', 'chrypnotoad', 'iruletheworldmo', 'aihegemonymemes'];
    const alwaysReplyAuthors = authors.filter(a => alwaysReplyToHandles.includes(a.username.toLowerCase()));
    const frequentAuthors = await responsesCollection.distinct('author_id', { created_at: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } });
    const frequentReplyAuthors = authors.filter(a => frequentAuthors.includes(a.id) && !alwaysReplyToHandles.includes(a.username));
    const newAuthors = authors.filter(a => !frequentAuthors.includes(a.id) && !alwaysReplyToHandles.includes(a.username));

    const targetAuthors = [...alwaysReplyAuthors, ...frequentReplyAuthors, ...newAuthors].slice(0, 6);
    for (const author of targetAuthors) {
      let xpost;
      if (tweetSet.has(author.id)) continue;

      // Get the latest unresponded tweet mentioning or replying to Bob
      xpost = await findLatestTweetMentioningOrReplyingToBob(db, author.id, alwaysReplyAuthors.map(a => a.id));
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

    await client.close();
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
