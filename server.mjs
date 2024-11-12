// server.js

import express from 'express';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3009;

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to parse JSON requests (if needed)
app.use(express.json());

// Function to connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    console.log('Connected to MongoDB');
    return client.db(process.env.DB_NAME);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
}

let db;
connectToMongoDB().then((database) => {
  db = database;
});

// API endpoint to get a list of all authors
app.get('/api/authors', async (req, res) => {
  try {
    const authorsCollection = db.collection('authors');
    const authors = await authorsCollection.find({}).toArray();

    // Map authors to include only necessary fields
    const authorsData = authors.map((author) => ({
      id: author.id,
      name: author.name,
      username: author.username,
      evolving_notes: author.evolving_notes || '',
    }));

    res.json(authorsData);
  } catch (error) {
    console.error('Error fetching authors:', error);
    res.status(500).send('Internal Server Error');
  }
});

// API endpoint to get the latest tweets and prompts for a specific author
app.get('/api/authors/:id/context', async (req, res) => {
  try {
    const authorId = req.params.id;
    const tweetsCollection = db.collection('tweets');
    const authorsCollection = db.collection('authors');
    const responsesCollection = db.collection('responses');

    // Fetch author details
    const author = await authorsCollection.findOne({ id: authorId });
    if (!author) {
      return res.status(404).send('Author not found');
    }

    // Fetch recent tweets
    const authorTweets = await tweetsCollection
      .find({ author_id: authorId })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();

    // Fetch the prompt and response if available
    const responseDoc = await responsesCollection.findOne({ author_id: authorId });

    res.json({
      author: {
        id: author.id,
        name: author.name,
        username: author.username,
        evolving_notes: author.evolving_notes || '',
      },
      tweets: authorTweets,
      prompt: responseDoc ? responseDoc.prompt : null,
      response: responseDoc ? responseDoc.response : null,
    });
  } catch (error) {
    console.error('Error fetching author context:', error);
    res.status(500).send('Internal Server Error');
  }
});

// API endpoint to get a specific tweet
app.get('/api/tweets/:id', async (req, res) => {
  try {
    const tweetId = req.params.id;
    const tweetsCollection = db.collection('tweets');
    const tweet = await tweetsCollection.findOne({ id: tweetId });

    if (!tweet) {
      return res.status(404).send('Tweet not found');
    }

    res.json(tweet);
  } catch (error) {
    console.error('Error fetching tweet:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
