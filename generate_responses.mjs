import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
const __dirname = path.resolve();

// Load environment variables from .env file
dotenv.config();

const TEXT_MODEL = process.env.TEXT_MODEL || '';
const OPENAI_API_URI = process.env.OPENAI_API_URI;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// use OpenAI to summarize the tweets
const openai = new OpenAI({
  baseURL: OPENAI_API_URI || 'http://127.0.0.1:11434/v1',
  apiKey: OPENAI_API_KEY || 'ollama'
});

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

async function summarizeRecentTweets(db, authorId, systemPrompt, prior) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');

  const author = await authorsCollection.findOne({
    id: authorId,
  });

  if (!author) {
    throw new Error(`Author with ID ${authorId} not found`);
  }

  const authorTweets = await tweetsCollection.find({
    author_id: authorId,
  }).sort({ created_at: -1 }).limit(50).toArray();

  let context = `Author: ${author.name} (@${author.username})\n`;
  for (const tweet of authorTweets) {
    context += `Tweet: ${tweet.text}\nDate: ${tweet.created_at}\n\n`;
  }

  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt || 'You are an alien intelligence from the future.' },
      { role: 'user', content: `${prior} \n\n${context}\n\nSummarize the vibe of the above tweet's author in one or two sentences.` },
    ],
    max_tokens: 100,
    temperature: 0.5,
  });

  return completion.choices[0].message.content.trim();
}

// Function to generate tweet response using Ollama's local API
async function generateTweetResponse(prompt, systemPrompt, journalEntry) {

  // Prepare the messages for Chat Completion
  const messages = [{ role: 'system', content: systemPrompt }];
  if (journalEntry) {
    messages.push({
      role: 'assistant', content: `
      ${journalEntry.createdAt}

      ${journalEntry.entry}
    ` });
  }
  messages.push({ role: 'user', content: `Today's Date is ${(new Date()).toDateString()}:\n\n${prompt}\n\nThis is twitter so all responses MUST be less than 280 characters. Respond with ONLY a short and humorous tweet.` });

  try {
    const completion = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages: messages,
      max_tokens: 128, // Adjust token limit as per tweet length
      temperature: 0.8, // Adjust creativity level
    });

    const responseText = completion.choices[0].message.content.trim();
    return responseText;
  } catch (error) {
    console.error('Error generating tweet response:', error);
    return null;
  }
}

// Main execution function
(async () => {
  try {
    const db = await connectToMongoDB();
    const tweetsCollection = db.collection('tweets');
    const responsesCollection = db.collection('responses');

    const authorsCollection = db.collection('authors');

    const bobthesnek = await authorsCollection.findOne({ username: 'bobthesnek' });
    if (!bobthesnek) {
      console.log('Author @bobthesnek not found.');
      return;
    }

    const bobId = bobthesnek.id;

    // Find all tweets that reference tweets by @bobthesnek
    // MongoDB aggregation pipeline to find tweet references
    const pipeline = [
      // First lookup to get author info
      {
        $lookup: {
          from: "authors",
          localField: "author_id",
          foreignField: "id",
          as: "author"
        }
      },
      // Unwind author array from lookup
      { $unwind: "$author" },

      // Lookup referenced tweets
      {
        $lookup: {
          from: "tweets",
          localField: "referenced_tweets.id",
          foreignField: "id",
          as: "referenced_tweet"
        }
      },
      { $unwind: "$referenced_tweet" },

      // Get author of referenced tweet
      {
        $lookup: {
          from: "authors",
          localField: "referenced_tweet.author_id",
          foreignField: "id",
          as: "referenced_author"
        }
      },
      { $unwind: "$referenced_author" },

      // Match tweets referencing bobthesnek
      {
        $match: {
          "referenced_author.username": "bobthesnek"
        }
      },

      // Project needed fields
      {
        $project: {
          _id: 0,
          tweet_id: "$id",
          tweet_text: "$text",
          author: "$author.username",
          referenced_tweet_id: "$referenced_tweet.id",
          referenced_tweet_text: "$referenced_tweet.text"
        }
      }
    ];

    // Usage:
    const replies = (await db.collection('tweets')
      .aggregate(pipeline).toArray())

    const shelly = await tweetsCollection
      .find({
        text: { $regex: '🐢<67>' }
      }).toArray();

    // find tweets that mention @bobthesnek
    const mentions = await tweetsCollection
      .find({
        text: /@bobthesnek/i,
        author: { $ne: 'bobthesnek' },
        author_id: { $ne: bobId }
      }).toArray();
    // find responses to any of those tweets
    const tweets = [...replies, ...mentions, ...shelly]
      .filter(t => t.author_id !== bobId && t.author !== 'bobthesnek');
    const prompts = await responsesCollection.find({
      tweet_id: { $in: tweets.map(t => t.id) },
      author_id: { $ne: bobId },
      response: { $exists: false }
    }).toArray();

    if (prompts.length === 0) {
      console.log('No prompts found without responses.');
      return;
    }

    // Specify your system prompt
    // Load the system prompt from a file assets/system_prompt.txt
    const dataFile = path.join(__dirname, 'assets', 'system_prompt.txt');

    let systemPrompt = 'You are an alien intelligence from the future.';
    try {
      systemPrompt = await fs.readFile(dataFile, 'utf8');
    } catch (error) {
      console.error('Error loading system prompt:', error);
    }

    const journalFile = path.join(__dirname, 'assets', 'latest_journal.json');
    let journalEntry = null;
    try {
      journalEntry = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    } catch (error) {
      console.error('Error loading journal entry:', error);
    }


    for (const promptDoc of prompts) {
      // get the prompt for the author if it exists
      const prompt_ = await authorsCollection.findOne({ id: promptDoc.author_id }).then(a => a.prompt);
      const prompt = await summarizeRecentTweets(
        db, promptDoc.author_id, 
        systemPrompt, prompt_ + `${promptDoc.prompt}`
      );
      // Update the prompt in author's database
      await authorsCollection.updateOne(
        { id: promptDoc.author_id },
        { $set: { prompt: prompt } }
      );
      const tweetResponse = await generateTweetResponse(prompt + promptDoc.prompt, systemPrompt, journalEntry);

      if (tweetResponse) {
        // Update the response in the database
        await responsesCollection.updateOne(
          { tweet_id: promptDoc.tweet_id },
          { $set: { response: tweetResponse } }
        );
        console.log(`Generated response for tweet ID ${promptDoc.tweet_id}: ${tweetResponse}`);
      } else {
        console.log(`Failed to generate response for tweet ID ${promptDoc.tweet_id}`);
      }
    }
  } catch (error) {
    console.error('Error generating tweet responses:', error);
    process.exit(1);
  }
})();
