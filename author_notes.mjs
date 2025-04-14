import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';

// Load environment variables from .env file
dotenv.config();

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(process.env.DB_NAME);
}

// Function to generate LLM context based on MongoDB data
async function generateLLMContext(db, authorId) {
  const tweetsCollection = db.collection('tweets');
  const authorsCollection = db.collection('authors');

  // Fetch tweets from the author
  const authorTweets = await tweetsCollection.find({ author_id: authorId }).sort({ created_at: -1 }).limit(50).toArray();
  const author = await authorsCollection.findOne({ id: authorId });

  if (!author) {
    throw new Error(`Author with ID ${authorId} not found`);
  }

  // Create context using author's tweets
  let context = `Author: ${author.name} (@${author.username})\n`;
  for (const tweet of authorTweets) {
    context += `Tweet: ${tweet.text}\nDate: ${tweet.created_at}\n\n`;
  }

  return context;
}

// Function to generate evolving notes about the author using LLM
async function generateEvolvingNotes(context, priorSummary) {
  let openai;
  if (process.env.USE_OPENAI_API === 'true') {
    openai = new OpenAI({
      baseURL: process.env.OPENAI_API_URI,
      apiKey: process.env.OPENAI_API_KEY,
    })
  } else {
    openai = new OpenAI({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama', // required but unused
    });
  }

  const prompt = `${priorSummary ? priorSummary + '\n\n' : ''}Given the following tweets from the author, generate evolving notes about the author's personality, interests, and communication style:\n\n${context}`;

  let response;
  if (process.env.USE_OPENAI_API === 'true') {
    response = await openai.chat.completions.create({
      model: process.env.TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
      temperature: 1.0,
    });
    return response.choices[0].message.content.trim();
  } else {
    response = await openai.chat.completions.create({
      model: 'llama3.2',
      messages: [{ role: 'user', content: prompt }],
    });
    return response.choices[0].message.content.trim();
  }
}

// Main execution function
(async () => {
  try {
    const db = await connectToMongoDB();
    const authorsCollection = db.collection('authors');

    // Fetch all authors
    const authors = await authorsCollection.find({}).toArray();

    for (const author of authors) {
      const authorId = author.id;
      const lastFetchedCount = author ? (author.last_fetched_count || 0) : 0;
      const currentTweetCount = await db.collection('tweets').countDocuments({ author_id: authorId });

      // If significant new tweets have been added, update evolving notes
      if (currentTweetCount - lastFetchedCount >= 1) {
        // Generate LLM context based on MongoDB data
        const context = await generateLLMContext(db, authorId);

        // Fetch prior summary if available
        const priorSummary = author ? author.evolving_notes : '';

        // Generate evolving notes using LLM
        const evolvingNotes = await generateEvolvingNotes(context, priorSummary);

        // Update the author's evolving notes and tweet count in MongoDB
        await authorsCollection.updateOne(
          { id: authorId },
          { $set: { evolving_notes: evolvingNotes, last_fetched_count: currentTweetCount } },
          { upsert: true }
        );

        console.log(`Generated Evolving Notes for ${author.username} (@${authorId}):\n`, evolvingNotes);
      } else {
        console.log(`Not enough new tweets to update evolving notes for ${author.username} (@${authorId}).`);
      }
    }
  } catch (error) {
    console.error('Error generating evolving notes:', error);
    process.exit(1);
  }
})();
