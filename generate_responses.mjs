// File: generate_responses.mjs
import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
const __dirname = path.resolve();

// -----------------------------------------------------------------------
// Environment variables and constants
// -----------------------------------------------------------------------
const TEXT_MODEL = process.env.TEXT_MODEL || '';
const OPENAI_API_URI = process.env.OPENAI_API_URI || 'http://127.0.0.1:11434/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'ollama';
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'test_db';
const NODE_ENV = process.env.NODE_ENV || 'development';
const MONGODB_TLS = (process.env.MONGODB_TLS || 'false').toLowerCase() === 'true';

const MAX_CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 5000; // 5 seconds between connection retries

// -----------------------------------------------------------------------
// OpenAI client instance
// -----------------------------------------------------------------------
const openai = new OpenAI({
  baseURL: OPENAI_API_URI,
  apiKey: OPENAI_API_KEY
});

// -----------------------------------------------------------------------
// Connect to MongoDB with retries
// -----------------------------------------------------------------------
async function connectToMongoDB() {
  /**
   * TLS/SSL config can be toggled via MONGODB_TLS.
   */
  const tlsOptions = MONGODB_TLS
    ? {
        tls: true,
        tlsAllowInvalidCertificates: NODE_ENV !== 'production',
        tlsAllowInvalidHostnames: NODE_ENV !== 'production'
      }
    : {
        // No TLS if MONGODB_TLS is false
      };

  // Connection options
  const options = {
    // Common settings
    retryWrites: true,
    w: 'majority',
    // Merge TLS options if needed
    ...tlsOptions
  };

  // Retry logic
  for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    try {
      console.log(`Attempt ${attempt} to connect to MongoDB...`);
      const client = new MongoClient(MONGODB_URI, options);
      await client.connect();
      console.log('Connected to MongoDB successfully');
      return client.db(DB_NAME);
    } catch (error) {
      console.error(`MongoDB connection error (attempt ${attempt}):`, error.message);

      // If we've hit our max attempts, re-throw the error
      if (attempt === MAX_CONNECT_RETRIES) {
        throw new Error(`Failed to connect to MongoDB: ${error.message}`);
      }

      // Otherwise, wait before retrying
      console.log(`Retrying in ${CONNECT_RETRY_DELAY_MS / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }

  // Fallback in case something else unexpected happens
  throw new Error('Unexpected: exceeded maximum MongoDB connection attempts.');
}

// -----------------------------------------------------------------------
// Summarize recent tweets
// -----------------------------------------------------------------------
async function summarizeRecentTweets(db, authorId, systemPrompt, prior) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');

  // Attempt to find the author
  const author = await authorsCollection.findOne({ id: authorId });

  let authorDetails = {
    name: 'Unknown',
    username: 'Unknown'
  };

  if (author) {
    authorDetails = {
      name: author.name,
      username: author.username
    };
  } else {
    console.warn(`Author with ID ${authorId} not found. Proceeding with fallback author details.`);
  }

  // Fetch recent tweets for the author
  const authorTweets = await tweetsCollection
    .find({ author_id: authorId })
    .sort({ created_at: -1 })
    .limit(10)
    .toArray();

  if (authorTweets.length === 0) {
    console.warn(`No tweets found for author ID ${authorId}.`);
    return `No tweets found for author ID ${authorId}. Unable to summarize.`;
  }

  // Build context
  let context = `Author: ${authorDetails.name} (@${authorDetails.username})\n`;
  for (const tweet of authorTweets) {
    context += `Tweet: ${tweet.text}\nDate: ${tweet.created_at}\n\n`;
  }

  let completion = null;

  const MAX_RETRIES = 5;
  const RETRY_DELAY = 2000; // 2 seconds

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Attempt ${attempt} to generate OpenAI completion...`);

      completion = await openai.chat.completions.create({
        model: TEXT_MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt || 'You are an alien intelligence from the future.'
          },
          {
            role: 'user',
            content: `${prior} \n\n${context}\n\nSummarize the vibe of the above tweet's author in one or two sentences.`
          }
        ],
        max_tokens: 100,
        temperature: 0.5
      });

      if (completion.choices && completion.choices[0]) {
        console.log('Successfully generated completion.');
        break;
      } else {
        console.warn('No valid response received from OpenAI, retrying...');
      }
    } catch (error) {
      console.error(`Error on attempt ${attempt} to generate completion:`, error.message);
    }

    // If not successful, delay before the next attempt
    if (attempt < MAX_RETRIES) {
      console.log(`Retrying OpenAI completion in ${RETRY_DELAY / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }

  if (!completion || !completion.choices || !completion.choices[0]) {
    throw new Error('Failed to generate OpenAI completion after maximum retries.');
  }

  return completion.choices[0].message.content.trim();
}

// -----------------------------------------------------------------------
// Generate tweet response using OpenAI's chat completion
// -----------------------------------------------------------------------
async function generateTweetResponse(prompt, systemPrompt, journalEntry) {
  // Prepare the messages for Chat Completion
  const messages = [{ role: 'system', content: systemPrompt }];

  if (journalEntry) {
    messages.push({
      role: 'assistant',
      content: `
        ${journalEntry.createdAt}

        ${journalEntry.entry}
      `
    });
  }

  // This is the actual user "prompt"
  messages.push({
    role: 'user',
    content: `Today's Date is ${(new Date()).toDateString()}:\n\n${prompt}\n\nThis is twitter so all responses MUST be less than 280 characters. Respond with ONLY a short and humorous tweet. Don't include any hashtags or urls.`
  });

  console.log('Generating tweet response...');

  try {
    const completion = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages,
      max_tokens: 128, // Adjust token limit as per tweet length
      temperature: 0.8 // Adjust creativity level
    });

    // Return the text of the first completion choice
    if (completion.choices && completion.choices[0]) {
      return completion.choices[0].message.content.trim();
    }
    return null;
  } catch (error) {
    console.error('Error generating tweet response:', error);
    return null;
  }
}

// -----------------------------------------------------------------------
// Main execution function
// -----------------------------------------------------------------------
async function main() {
  let db;
  try {
    // 1) Connect to Mongo
    db = await connectToMongoDB();

    // 2) Grab references to collections
    const responsesCollection = db.collection('responses');
    const authorsCollection = db.collection('authors');
    const postsCollection = db.collection('tweets');

    // 3) Find the ID of Bob
    const bobAuthor = await authorsCollection.findOne({ username: 'bobthesnek' });
    const bobId = bobAuthor ? bobAuthor.id : null;

    // 4) Fetch prompts that are missing a response but have been processed for LLM context
    const prompts = await responsesCollection
      .find({
        author_id: { $ne: bobId },
        response: { $exists: false },
        processed_by: 'llm_context',
        processed_at: { $exists: true }
      })
      .toArray();

    if (prompts.length === 0) {
      console.log('No prepared prompts found to process.');
      return;
    }

    console.log(`Found ${prompts.length} prepared prompts to process`);

    // 5) Load system prompt from file, or fallback
    let systemPrompt = 'You are an alien intelligence from the future.';
    try {
      const dataFile = path.join(__dirname, 'assets', 'system_prompt.txt');
      systemPrompt = await fs.readFile(dataFile, 'utf8');
    } catch (error) {
      console.error('Error loading system prompt:', error);
    }

    // 6) Load the latest journal entry from JSON file
    let journalEntry = null;
    try {
      const journalFile = path.join(__dirname, 'assets', 'latest_journal.json');
      journalEntry = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    } catch (error) {
      console.error('Error loading journal entry:', error);
    }

    // 7) Process each prompt
    for (const promptDoc of prompts) {
      console.log(`Processing prompt for tweet ${promptDoc.tweet_id}`);

      // Get the author_id, fallback to extracting from the tweet
      let author_id = promptDoc.author_id;
      if (!author_id) {
        const tweet = await postsCollection.findOne({ id: promptDoc.tweet_id });
        if (tweet) {
          author_id = tweet.author_id;
        }
        if (!author_id) {
          console.warn(
            `No author_id found for tweet ID ${promptDoc.tweet_id}, skipping this prompt.`
          );
          continue;
        }
      }

      // Get the author's existing prompt if available
      const author = await authorsCollection.findOne({ id: author_id });
      const authorPrompt = author?.prompt || '';

      // Get the tweet and fetch recent posts
      const tweet = await postsCollection.findOne({ id: promptDoc.tweet_id });
      const recent_posts = await postsCollection
        .find({ author_id })
        .sort({ id: -1 })
        .limit(100)
        .toArray();
      recent_posts.reverse();

      // Summarize recent tweets
      const summarizedPrompt = await summarizeRecentTweets(
        db,
        author_id,
        systemPrompt,
        `${authorPrompt}\n${recent_posts.map((t) => t.text).join('\n')}\n${promptDoc.context}`
      );

      // Update the author's database record with the new prompt
      await authorsCollection.updateOne(
        { id: author_id },
        { $set: { prompt: summarizedPrompt } }
      );

      // Generate a tweet response using the new prompt
      const tweetResponse = await generateTweetResponse(
        `You have these feelings towards the author you are responding to: ${summarizedPrompt}
         Here is some recent context:\n\n${promptDoc.context}`,
        systemPrompt,
        journalEntry
      );

      if (tweetResponse) {
        // Update the response in the database
        await responsesCollection.updateOne(
          { tweet_id: promptDoc.tweet_id },
          {
            $set: {
              response: tweetResponse,
              response_generated_at: new Date()
            }
          }
        );
        console.log(`Generated response for tweet ID ${promptDoc.tweet_id}: ${tweetResponse}`);
      } else {
        console.log(`Failed to generate response for tweet ID ${promptDoc.tweet_id}`);
      }
    }
  } catch (error) {
    console.error('Error generating tweet responses:', error);
    // Wait for a minute before exiting to prevent rapid restarts
    await new Promise((resolve) => setTimeout(resolve, 60000));
    process.exit(1);
  }
}

// -----------------------------------------------------------------------
// Loop function to continuously run main() in intervals
// -----------------------------------------------------------------------
async function loop() {
  while (true) {
    try {
      await main();
    } catch (err) {
      console.error(
        'Uncaught error in loop(). Waiting for 1 minute before retry...',
        err
      );
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }

    const niceDate = new Date().toLocaleString('en-US');
    console.log(`${niceDate} Waiting for next iteration...`);

    // Wait 5 minutes before next iteration
    await new Promise((resolve) => setTimeout(resolve, 1000 * 60 * 5));
  }
}

// -----------------------------------------------------------------------
// Start the loop
// -----------------------------------------------------------------------
loop().catch(console.error);
