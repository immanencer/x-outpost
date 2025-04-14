// server.mjs

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

// NEW: API endpoint to get a paginated list of tweets with filtering
app.get('/api/tweets', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const filter = req.query.filter || 'all';
    const search = req.query.search || '';
    
    const tweetsCollection = db.collection('tweets');
    const responsesCollection = db.collection('responses');
    
    // Build the query based on filter and search
    let query = {};
    
    // Handle filter for tweet processing status
    if (filter === 'processed') {
      query['processing_status.llm_context'] = true;
    } else if (filter === 'unprocessed') {
      query['processing_status.llm_context'] = { $ne: true };
    }
    
    // Handle search
    if (search) {
      query.text = { $regex: search, $options: 'i' };
    }
    
    // Special handling for posted/not-posted filters will be done after fetching responses
    const isPostedFilter = filter === 'posted' || filter === 'not-posted';
    
    // Execute the query
    const tweets = await tweetsCollection
      .find(query)
      .sort({ created_at: -1 })
      .toArray(); // Remove skip/limit for now since we'll filter later
    
    // Get the total count for pagination before applying response filters
    const total = await tweetsCollection.countDocuments(query);
    
    // Fetch responses for these tweets
    const tweetIds = tweets.map(tweet => tweet.id);
    const responses = await responsesCollection
      .find({ tweet_id: { $in: tweetIds } })
      .toArray();
    
    // Create a map of tweet_id to response for quick lookup
    const responseMap = {};
    responses.forEach(response => {
      responseMap[response.tweet_id] = response;
    });
    
    // Fetch author usernames
    const authorIds = [...new Set(tweets.map(tweet => tweet.author_id))];
    const authors = await db.collection('authors')
      .find({ id: { $in: authorIds } })
      .toArray();
    
    // Create a map of author_id to username for quick lookup
    const authorMap = {};
    authors.forEach(author => {
      authorMap[author.id] = author.username;
    });
    
    // Combine tweets with their responses and author usernames
    let tweetsWithResponses = tweets.map(tweet => ({
      ...tweet,
      response: responseMap[tweet.id] || null,
      author_username: authorMap[tweet.author_id] || null
    }));
    
    // Apply filters for responses
    if (filter === 'with-response') {
      tweetsWithResponses = tweetsWithResponses.filter(tweet => tweet.response && tweet.response.response);
    } else if (filter === 'without-response') {
      tweetsWithResponses = tweetsWithResponses.filter(tweet => !tweet.response || !tweet.response.response);
    } else if (filter === 'posted') {
      tweetsWithResponses = tweetsWithResponses.filter(tweet => tweet.response && tweet.response.posted === true);
    } else if (filter === 'not-posted') {
      tweetsWithResponses = tweetsWithResponses.filter(tweet => 
        tweet.response && 
        tweet.response.response && 
        (tweet.response.posted === false || tweet.response.posted === undefined)
      );
    }
    
    // Apply pagination after filtering
    const paginatedTweets = tweetsWithResponses.slice(skip, skip + limit);
    
    res.json({
      tweets: paginatedTweets,
      total: isPostedFilter ? tweetsWithResponses.length : total, // Adjust total for special filters
      page: page,
      pages: Math.ceil((isPostedFilter ? tweetsWithResponses.length : total) / limit)
    });
  } catch (error) {
    console.error('Error fetching tweets:', error);
    res.status(500).send('Internal Server Error');
  }
});

// DELETE /api/tweets/:tweetId/response - Delete a response for a tweet
app.delete('/api/tweets/:tweetId/response', async (req, res) => {
  try {
    const tweetId = req.params.tweetId;
    
    if (!tweetId) {
      return res.status(400).json({ error: 'Tweet ID is required' });
    }
    
    // Check if db connection is initialized
    if (!db) {
      return res.status(503).json({ error: 'Database connection not available' });
    }
    
    // Find the response first to check if it's posted
    const responsesCollection = db.collection('responses');
    const response = await responsesCollection.findOne({ tweet_id: tweetId });
    
    if (!response) {
      return res.status(404).json({ error: 'Response not found' });
    }
    
    // Check if response has been posted - don't allow deleting posted responses
    if (response.posted === true) {
      return res.status(403).json({ 
        error: 'Cannot delete a response that has already been posted' 
      });
    }
    
    // For responses that haven't been posted, we need to completely remove
    // the response field (not just set it to empty), so the document appears
    // in queries where response: { $exists: false }
    const result = await responsesCollection.updateOne(
      { tweet_id: tweetId },
      { 
        $unset: { 
          response: 1, 
          response_generated_at: 1 
        } 
      }
    );
    
    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: 'Failed to delete response' });
    }
    
    // Also update the tweet to completely remove response information if necessary
    const tweetsCollection = db.collection('tweets');
    await tweetsCollection.updateOne(
      { id: tweetId },
      { 
        $unset: { 
          "response.response": 1,
          "response.response_generated_at": 1 
        } 
      }
    );
    
    return res.status(200).json({ 
      message: 'Response deleted successfully',
      tweetId: tweetId
    });
  } catch (error) {
    console.error('Error deleting response:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the tweets.html file
app.get('/tweets', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tweets.html'));
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
