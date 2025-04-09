// File: generate_responses.mjs
import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';
const __dirname = path.resolve();

// -----------------------------------------------------------------------
// Environment variables and constants
// -----------------------------------------------------------------------
const TEXT_MODEL = process.env.TEXT_MODEL || 'gpt-3.5-turbo'; // Default to a known model
const OPENAI_API_URI = process.env.OPENAI_API_URI || 'http://127.0.0.1:11434/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'your-openai-api-key';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'test_db';
const NODE_ENV = process.env.NODE_ENV || 'development';
const MONGODB_TLS = (process.env.MONGODB_TLS || 'false').toLowerCase() === 'true';

const MAX_CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 5000; // 5 seconds between connection retries

// -----------------------------------------------------------------------
// Helper function to filter tweets
// -----------------------------------------------------------------------
function isTweetValid(text) {
  // Regex to match links (http:// or https://)
  const linkRegex = /https?:\/\/\S+/i;
  // Check if text contains the word "pump" (case-insensitive)
  const containsPump = text.toLowerCase().includes('pump');
  
  return !linkRegex.test(text) && !containsPump;
}

// -----------------------------------------------------------------------
// OpenAI client instance
// -----------------------------------------------------------------------
const openai = new OpenAI({
  baseURL: OPENAI_API_URI,
  apiKey: OPENAI_API_KEY
});

// -----------------------------------------------------------------------
// Connect to MongoDB with retries and maintain a single connection
// -----------------------------------------------------------------------
let mongoClient;
let db;

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
    : {};

  // Connection options
  const options = {
    retryWrites: true,
    w: 'majority',
    ...tlsOptions
  };

  // Retry logic
  for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    try {
      console.log(`Attempt ${attempt} to connect to MongoDB...`);
      mongoClient = new MongoClient(MONGODB_URI, options);
      await mongoClient.connect();
      db = mongoClient.db(DB_NAME);
      console.log('Connected to MongoDB successfully');
      return;
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
async function summarizeRecentTweets(authorId, systemPrompt, prior) {
  try {
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

    // Fetch recent tweets for the author and filter out tweets with links or "pump"
    const rawTweets = await tweetsCollection
      .find({ author_id: authorId })
      .sort({ created_at: -1 })
      .limit(10)
      .toArray();

    const authorTweets = rawTweets.filter(tweet => isTweetValid(tweet.text));

    if (authorTweets.length === 0) {
      console.warn(`No valid tweets found for author ID ${authorId}.`);
      return `No valid tweets found for author ID ${authorId}. Unable to summarize.`;
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

        if (completion.choices && completion.choices[0] && completion.choices[0].message) {
          console.log('Successfully generated completion.');
          console.log(completion.choices[0].message.content.trim());
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

    if (!completion || !completion.choices || !completion.choices[0] || !completion.choices[0].message) {
      throw new Error('Failed to generate OpenAI completion after maximum retries.');
    }

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error in summarizeRecentTweets:', error.message);
    throw error;
  }
}

// -----------------------------------------------------------------------
// Generate tweet response using OpenAI's chat completion
// -----------------------------------------------------------------------
async function generateTweetResponse(prompt, systemPrompt, journalEntry) {
  try {
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
      content: `Today's Date is ${(new Date()).toDateString()}:\n\n${prompt}.
      Generate a short cute and funny tweet response that advances your goals. 🐍`
    });

    console.log('Generating tweet response...');

    const completion = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages,
      max_tokens: 128, // Adjust token limit as per tweet length
      temperature: 0.8 // Adjust creativity level
    });

    // Return the text of the first completion choice
    if (completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content.trim() !== '') {
      return completion.choices[0].message.content.trim();
    }

    throw new Error('Failed to generate a valid completion.');
  } catch (error) {
    console.error('Error generating tweet response:', error.message);
    throw error;
  }
}

// -----------------------------------------------------------------------
// Main execution function
// -----------------------------------------------------------------------
async function main() {
  try {
    // Grab references to collections
    const responsesCollection = db.collection('responses');
    const authorsCollection = db.collection('authors');
    const postsCollection = db.collection('tweets');

    // Find the ID of Bob
    const bobAuthor = await authorsCollection.findOne({ username: 'bobthesnek' });
    const bobId = bobAuthor ? bobAuthor.id : null;

    // Fetch prompts that are missing a response but have been processed for LLM context
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

    // Load system prompt from file, or fallback
    let systemPrompt = 'You are an alien intelligence from the future.';
    try {
      const dataFile = path.join(__dirname, 'assets', 'system_prompt.txt');
      systemPrompt = await fs.readFile(dataFile, 'utf8');
    } catch (error) {
      console.error('Error loading system prompt:', error.message);
    }

    // Load the latest journal entry from JSON file
    let journalEntry = null;
    try {
      const journalFile = path.join(__dirname, 'assets', 'latest_journal.json');
      const journalContent = await fs.readFile(journalFile, 'utf8');
      journalEntry = JSON.parse(journalContent);
    } catch (error) {
      console.error('Error loading journal entry:', error.message);
    }

    // Process each prompt
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

      // Get the tweet and fetch recent posts, filtering out tweets with links or "pump"
      const rawRecentPosts = await postsCollection
        .find({ author_id })
        .sort({ id: -1 })
        .limit(100)
        .toArray();
      // Reverse the posts to get them in chronological order and filter invalid ones
      const recent_posts = rawRecentPosts.reverse().filter(post => isTweetValid(post.text));

      // Summarize recent tweets
      let summarizedPrompt;
      try {
        summarizedPrompt = await summarizeRecentTweets(
          author_id,
          systemPrompt,
          `${authorPrompt}\n${recent_posts.map((t) => t.text).join('\n')}\n${promptDoc.context}`
        );
      } catch (error) {
        console.error(`Failed to summarize tweets for author ID ${author_id}:`, error.message);
        continue; // Skip this prompt and move to the next
      }

      // Update the author's database record with the new prompt
      try {
        await authorsCollection.updateOne(
          { id: author_id },
          { $set: { prompt: summarizedPrompt } }
        );
      } catch (error) {
        console.error(`Failed to update author prompt for author ID ${author_id}:`, error.message);
        continue; // Skip this prompt and move to the next
      }

      // Generate a tweet response using the new prompt
      let tweetResponse;
      try {
        tweetResponse = await generateTweetResponse(
          `${summarizedPrompt}
           
          ${promptDoc.context}`,
          systemPrompt,
          journalEntry
        );
      } catch (error) {
        console.error(`Failed to generate tweet response for tweet ID ${promptDoc.tweet_id}:`, error.message);
        continue; // Skip this prompt and move to the next
      }

      if (tweetResponse) {
        // Update the response in the database
        try {
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
        } catch (error) {
          console.error(`Failed to update response for tweet ID ${promptDoc.tweet_id}:`, error.message);
        }
      } else {
        console.log(`Failed to generate response for tweet ID ${promptDoc.tweet_id}`);
      }
    }
  } catch (error) {
    console.error('Error generating tweet responses:', error.message);
    throw error; // Let the loop handle the retry
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
        err.message
      );
      await new Promise((resolve) => setTimeout(resolve, 60000));
      continue; // Continue to the next iteration after waiting
    }

    const niceDate = new Date().toLocaleString('en-US');
    console.log(`${niceDate} Waiting for next iteration...`);

    // Wait 5 minutes before next iteration
    await new Promise((resolve) => setTimeout(resolve, 1000 * 60 * 5));
  }
}

// -----------------------------------------------------------------------
// Start the application
// -----------------------------------------------------------------------
(async () => {
  try {
    await connectToMongoDB();
    loop().catch(console.error);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('Shutting down gracefully...');
      if (mongoClient) {
        await mongoClient.close();
        console.log('MongoDB connection closed.');
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('Failed to start the application:', error.message);
    process.exit(1);
  }
})();
