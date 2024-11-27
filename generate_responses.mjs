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
  const options = {
    tls: true,
    tlsAllowInvalidCertificates: process.env.NODE_ENV !== 'production',
    tlsAllowInvalidHostnames: process.env.NODE_ENV !== 'production',
    retryWrites: true,
    w: 'majority'
  };

  try {
    const client = new MongoClient(process.env.MONGODB_URI, options);
    await client.connect();
    console.log('Connected to MongoDB successfully');
    return client.db(process.env.DB_NAME);
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw new Error(`Failed to connect to MongoDB: ${error.message}`);
  }
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
  messages.push(
    { role: 'user', content: `Today's Date is ${(new Date()).toDateString()}:
    \n\n${prompt}\n\n
    This is twitter so all responses MUST be less than 280 characters.
    Respond with ONLY a short and humorous tweet.
    Don't include any hashtags or urls.
    ` });

  console.log('Generating tweet response...');
  //console.log(prompt);
  
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
async function main () {
  let db;
  try {
    db = await connectToMongoDB();
    const responsesCollection = db.collection('responses');
    const authorsCollection = db.collection('authors');


    const bobId = await authorsCollection.findOne({ username: 'bobthesnek' }).then(a => a.id);
    const prompts = await responsesCollection.find({
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
    // Wait for a minute before exiting to prevent rapid restarts
    await new Promise(resolve => setTimeout(resolve, 60000));
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